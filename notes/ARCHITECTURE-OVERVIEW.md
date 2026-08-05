# ShopIQ Architecture — How the Whole System Works

**Course:** ShopIQ Mentor Program — Day 2, integrated view
**Goal:** See every piece we've built as one system: the data flows, the components, the shared patterns, and how the remaining days (RAG, MCP, orchestration) plug in on top.

---

## 1. The Architecture at a Glance

```
┌──────────────────┐   ┌─────────────────────────┐
│ seed documents   │   │ Online Retail II xlsx    │   <- data sources (both go through
│ (policy_seed.py) │   │ (data/raw/*.xlsx)         │      the same code paths)
└────────┬─────────┘   └────────────┬────────────┘
         │                          │
         ▼                          ▼
  ingest_policies.py          load_sales.py
  chunk → embed → upsert      parse → clean → upsert → refresh
         │                          │
         │              ┌───────────▼───────────┐
         │              │   PostgreSQL (Docker)  │
         └─────────────▶│  products / orders /   │
                        │  order_items           │
   document_chunks      │  stock_view (MV)       │
   (vector 2048)        │  policy_documents      │
                        └───────────┬───────────┘
                                    │
                                    ▼
                      search_policies.py
                      embed query → nearest neighbors
                                    │
                       (Day 3: feeds the LLM → cited answers)
```

**Two data flows, two interaction outputs, one codebase.** Structured sales data and unstructured policy text enter through *separate* ingest paths but share the same Postgres instance; retrieval pulls *both* kinds of data back out.

---

## 2. The Components and Their Jobs

| File | Job | Side of the system |
|---|---|---|
| `backend/db.py` | Open one Postgres connection from `.env` config | plumbing |
| `backend/schema.sql` | Define every table/view/index | structured + unstructured + governance |
| `backend/load_sales.py` | xlsx → clean → upsert → refresh stock view | structured ingest |
| `backend/policy_seed.py` | The self-authored policy corpus (pure data) | unstructured source |
| `backend/ingest_policies.py` | docs → chunks → embed → upsert chunks | unstructured ingest |
| `backend/embeddings.py` | text → vector via OpenRouter (the only place that talks to the embedder) | shared client |
| `backend/search_policies.py` | question → vector → nearest chunks | retrieval |
| `requirements.txt` | The Python dependencies | environment |

---

## 3. The Structured Data Flow (sales)

```
online_retail_II.xlsx (525,461 rows)
  │ pd.read_excel
  ▼
clean_sales()      validate columns → drop cancellations/nulls/junk
  │                → normalize identifiers to strings → drop bad prices
  ▼
407,050 clean rows
  │
  ▼  load() — ONE transaction
  ├── products   upsert  (ON CONFLICT (sku) DO UPDATE)      → 4,011
  ├── orders     upsert  (ON CONFLICT (order_id) DO NOTHING) → 19,040
  ├── order_items upsert (ON CONFLICT (order_id, product_id)
  │                         DO UPDATE quantity += EXCLUDED)  → 394,389
  └── REFRESH MATERIALIZED VIEW stock_view   (recompute derived stock)
```

**Key design decision:** this is **one code path**. The same `clean_sales()` + `load()` functions will later be called by the `/data` upload page — whether data comes from the seed file or a user's upload, it goes through identical logic. That's what makes the system testable: *swap in different data, ask the agent about it, no redeploy.*

**Derived stock philosophy:** the dataset has no live inventory field, so `stock_view` computes `initial_stock − SUM(quantity sold)`, floored at zero. The assumption is documented, not hidden.

---

## 4. The Unstructured Data Flow (documents → vectors)

```
policy_seed.py (6 docs × sections)
  │
  ▼  ingest_policies.py
chunk_document()      each (heading, body) → a citable chunk
  │                    content = "Title — Section:\nbody"
  ▼
upsert_document()     INSERT doc ... ON CONFLICT (title) DO UPDATE ... RETURNING doc_id
  │                    DELETE old chunks for that doc (replace, never duplicate)
  ▼
embed in batches of 20 → INSERT chunk + vector into document_chunks
```

**Result:** 6 documents → 19 chunks, each with a `section_label`, a `chunk_index`, and a 2048-dim `embedding`.

**The replace-on-reingest rule** matters: re-running ingestion with the same titles updates the docs instead of piling up duplicates — so the corpus is always a clean reflection of the current source.

---

## 5. The Retrieval Flow (question → relevant chunks)

```
"my charger stopped working, do I have any recourse?"
  │ embed_texts([question])[0]     # SAME model as stored chunks
  ▼
2048-dim query vector
  │
  ▼
SELECT p.title, c.section_label, c.content, c.embedding <=> :vec AS dist
FROM document_chunks c JOIN policy_documents p USING (doc_id)
ORDER BY dist LIMIT 5
  │
  ▼
top-k chunks ranked by cosine distance
```

- **Smaller distance = more similar.** Our proof: the query above shares *zero words* with the docs, yet "Defective Items" and "Opened Electronics" surface — semantic, not keyword, retrieval.
- **Day 3 adds the LLM on top:** these chunks become context, the model writes an answer, and a grounding threshold decides whether to answer at all or say "no relevant policy found."

---

## 6. The Shared Patterns (learn these once, reuse everywhere)

### 6.1 Connect → do work → close
Every script: `get_conn()` → run queries → `conn.close()`. Centralizing connection config in `db.py` means changing hosts/creds touches one file.

### 6.2 Transactions everywhere
- `load_sales.py`: `with conn.transaction():` — auto-commit or rollback.
- `ingest_policies.py`: statements then one `conn.commit()`.
Both give **atomicity**: a failure mid-way can't leave half-loaded data.

### 6.3 One embedding client
All calls to the embedder live in `embeddings.py`. The model name is an env var. **This is the swap point** — changing provider or model is a config change, not a refactor.

### 6.4 Idempotent upserts
Every write path uses `ON CONFLICT` so re-running a load or an upload **merges** rather than duplicates. Critical for the "swap data, ask again" demo flow.

### 6.5 Fail loudly
`raise_for_status()`, `ValueError` on missing columns, `ON_ERROR_STOP=1` when applying schema. Silent failures are the enemy — the 350k-row bug taught us that.

### 6.6 Verify counts
After any load we print table counts and sanity-check them against expectations. A number that doesn't match = investigate before moving on.

---

## 7. How the Coming Days Plug In (the roadmap view)

| Day | What gets added | Where it connects |
|---|---|---|
| **3 — RAG** | `search_policies` results → LLM prompt → cited answer + grounding threshold | Sits on top of `search_policies.py` |
| **4 — MCP** | Python MCP server exposing 10 tools — `check_stock`, `sales_trend`, `search_policies`, `flag_reorder`, `notify_channel`, `top_sellers`, `search_products`, `list_actions`, `approve_action`, `list_policies` — all audit-logged | Wraps the same DB queries; adds the agent-accessible surface + governance |
| **5 — Orchestration** | Next.js API route running the tool-call loop against OpenRouter | Connects to the MCP server; uses the LLM for the first time |
| **6 — Governance** | `action_log` rows, guardrails, Telegram | Uses the governance tables we already created |
| **7 — Deploy** | Dockerize backend, Vercel frontend, demo script | The whole thing ships |

**Why this scales conceptually:** the retrieval + structured-data layers are built and tested independently. Every later day is a *thin wrapper* on top — an API endpoint here, an LLM call there — rather than a rewrite of the data layer.

---

## 8. The One-Paragraph Architecture Story

> "ShopIQ has two data flows into one Postgres database: a real retail transaction dataset, cleaned and loaded with idempotent upserts into `products`/`orders`/`order_items`, with stock derived as a refreshed materialized view; and a policy corpus that's chunked by section and embedded into `document_chunks` as 2048-dim vectors. One shared embedding client, one connection helper, one transaction discipline. Retrieval embeds the question with the same model and ranks chunks by cosine distance — which is how a question with zero shared vocabulary still finds the right policy. Everything that comes later — RAG answers, MCP tools, agent orchestration, governance — is a wrapper on top of these two flows."

---

## 9. Practice Questions

1. Why do the seed loader and the future `/data` upload share the same functions instead of being separate?
2. Trace the full path of a new policy document from `policy_seed.py` to a searchable chunk.
3. What would happen if we re-ran `load_sales.py` on the same file a second time? (Answer: counts stay the same — upserts merge.)
4. Which file would you edit to switch embedding providers, and why is that the *only* file?
5. Name the three shared patterns that every script follows.
6. Where does the grounding threshold fit in the architecture (which step, before or after retrieval)?
