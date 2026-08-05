# ShopIQ — Implementation Guide (How We Built Everything, Days 1–4)

A self-contained walkthrough of *what exists, why it exists, and how to
reproduce it*. Read this to reconstruct the project from a blank machine, or to
orient yourself before the interview. Concept notes live in `DAY-*.md`; this
note is the *build* story.

---

## 1. Tech stack (the whole picture)

| Layer | Technology | Why |
|---|---|---|
| Database | **PostgreSQL 16 + pgvector** in Docker | vector + relational in one place; one DB to run |
| Embeddings | **OpenRouter `/embeddings`**, `nvidia/llama-nemotron-embed-vl-1b-v2:free` | 2048-dim, free, hosted — no 5GB local install |
| Chat model | **OpenRouter chat completions**, `openai/gpt-oss-20b:free` | free, decent format adherence |
| Data layer | **psycopg3, pandas, openpyxl** | parameterized SQL; parse the seed xlsx |
| Retrieval | **pgvector `<=>` cosine** on `document_chunks` | semantic search in pure SQL |
| Tools layer | **MCP Python SDK (`FastMCP`), pinned `mcp==1.29.0`** | standard AI↔tool wire |
| Backend API | **FastAPI + uvicorn** | `/api/chat` + CORS + threadpool |
| Frontend | **Next.js 16 + shadcn/ui (Tailwind v4)** | monochrome chat UI |
| Config | **python-dotenv** + `.env` | keys never in code |

Environment: Python 3.14 venv at `.venv/`, Node v22, Docker 29. The only heavy
install was Postgres itself (inside Docker); everything else is small.

---

## 2. Environment setup (reproduce from scratch)

```bash
# 1. Postgres with pgvector, as a Docker container
docker run -d --name shopiq-db \
  -e POSTGRES_USER=shopiq -e POSTGRES_PASSWORD=shopiq \
  -e POSTGRES_DB=shopiq -p 5432:5432 \
  -v shopiq_pgdata:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

# (restart later with: docker start shopiq-db)

# 2. Python venv + deps
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. .env (gitignored) — user-supplied OpenRouter key
#    DATABASE_URL=postgresql://shopiq:shopiq@localhost:5432/shopiq
#    OPENROUTER_API_KEY=sk-or-...
#    OPENROUTER_MODEL=openai/gpt-oss-20b:free
#    EMBEDDING_MODEL=nvidia/llama-nemotron-embed-vl-1b-v2:free
#    EMBEDDING_DIM=2048

# 4. Create schema + load everything
psql "$DATABASE_URL" -f backend/schema.sql            # tables + vector ext
.venv/bin/python backend/load_sales.py                # retail dataset
.venv/bin/python backend/policy_seed.py               # write seed docs (idempotent)
.venv/bin/python backend/ingest_policies.py           # chunk + embed
```

Verified counts: **4,011 products · 19,040 orders · 394,389 order_items ·
1,739 out-of-stock · 19 policy chunks · ~5.5M units sold.**

---

## 3. The database (8 tables + 1 view)

| Table | Purpose | Key columns |
|---|---|---|
| `products` | catalog | `sku` (unique), `description`, `unit_price`, `initial_stock` |
| `orders` | invoices | `order_id` (PK), `customer_id`, `order_date`, `country` |
| `order_items` | line items | FK `order_id`, FK `product_id`, `quantity`, `unit_price` |
| `stock_view` (MV) | derived stock | `current_stock = GREATEST(initial_stock − Σ sold, 0)` |
| `policy_documents` | RAG corpus docs | `title` (unique), `source_type`, `raw_text` |
| `document_chunks` | embedded chunks | FK `doc_id`, `section_label`, `content`, `embedding vector(2048)` |
| `action_log` | governance audit (Day 6) | `tool_name`, `arguments`, `result`, `status enum` |
| `reorder_flags` | restock requests (Day 6) | `product_id`, `suggested_quantity`, `reasoning`, `action_id` |
| `telegram_messages` | notification queue (Day 6) | `message_id`, `chat_id`, `payload`, `status` |

Design decisions worth naming:
- **`vector(2048)`** must match the embedding model's output dim exactly —
  mismatch = Postgres error.
- **No HNSW index** — pgvector indexes cap at **2000 dims**, our model emits
  2048. At ~20 chunks, exact search is sub-millisecond. Documented in
  `schema.sql` with the scale-up path (1536-dim embedder → enable HNSW).
- **`CREATE TYPE ... AS ENUM` has no `IF NOT EXISTS`** — wrapped in a `DO $$
  BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` block so
  re-running `schema.sql` is safe.
- **Everything is `IF NOT EXISTS`** — re-running the schema is harmless.

---

## 4. Module map (what each file does)

| File | Layer | Job |
|---|---|---|
| `backend/db.py` | plumbing | one `get_conn()` from `.env`; used by every script |
| `backend/embeddings.py` | shared client | `embed_texts()` → OpenRouter `/embeddings`, batched |
| `backend/schema.sql` | schema | all tables/views/indexes (idempotent) |
| `backend/load_sales.py` | ingest | xlsx → clean → upsert → refresh `stock_view` |
| `backend/policy_seed.py` | data | the 6 policy docs (pure content) |
| `backend/ingest_policies.py` | ingest | chunk by section → embed (batch 20) → upsert, replace-on-reingest |
| `backend/search_policies.py` | retrieval | question → embed → `<=>` → top-k chunks |
| `backend/llm.py` | LLM client | chat completions + retry/backoff; Day 5 extends with tools |
| `backend/rag_answer.py` | RAG | retrieve → ground → cited answer |
| `backend/mcp_server.py` | tools | FastMCP server, 5 tools |
| `backend/mcp_test_client.py` | tools | SDK client harness (the agent-loop pattern) |
| `backend/mcp_raw_client.py` | tools | hand-written JSON-RPC client to show the wire |
| `backend/llm.py` | LLM client | chat completions + tools/tool_calls + retry/backoff |
| `backend/agent.py` | orchestration | the reason–act loop; MCP-client-driven |
| `backend/main.py` | API | FastAPI `/api/chat` + CORS + threadpool offload |
| `frontend/src/components/chat.tsx` | UI | monochrome shadcn chat (badges, chips, selector) |
| `frontend/src/lib/parse-citations.ts` | UI | splits answers on `[doc :: section]` |

**The dependency rule:** nothing imports `llm`/`mcp`/`rag` except downward.
`search_policies` doesn't know about the LLM; `mcp_server` doesn't know about
RAG answers; `rag_answer` knows about `search` + `complete`. Each layer stays
testable in isolation.

---

## 5. The two data flows (and how they meet)

```
FLOW A — structured sales                  FLOW B — unstructured policies
online_retail_II.xlsx                      policy_seed.py (6 docs)
        │                                          │
        ▼  load_sales.py                           ▼ ingest_policies.py
clean → upsert → refresh stock_view          chunk by section
        │                                          │ embed (batch 20)
        ▼                                          ▼
 products / orders / order_items            document_chunks (vector 2048)
        │                                          │
        └──────────────┬───────────────────────────┘
                       ▼
              PostgreSQL (one instance)
                       │
                       ▼
   search_policies.py  ──┐
   rag_answer.py         ├─ both feed the Day 4 MCP server
   mcp_server.py         ──┘  (search_policies, check_stock, sales_trend,
                                flag_reorder, notify_channel)
```

Structured data answers "what's in stock / how are sales?"
Unstructured data answers "what's the policy?" The **agent (Day 5) uses both**
through the same MCP surface.

---

## 6. The read path end-to-end (question → answer → tool) — LIVE

```
user: "We're out of the white hanging heart t-light holder, order more."
        │
        ▼  agent loop (backend/agent.py): LLM + MCP tools
   llm.chat(messages + tools-from-tools/list)   → model returns tool_calls
        │
        ├─ tools/call search_products("white hanging heart")  → SKU 85123A
        ├─ tools/call top_sellers(5)                          → it IS a top seller
        ├─ tools/call flag_reorder("85123A", 500, "...")      → reorder flag
        ├─ tools/call notify_channel("Reorder flag #3 ...")   → message queued
        │
        ▼  results fed back as role:tool messages → model writes final answer
   "Reorder flag created for SKU 85123A ... The team has been notified."
        │
        ▼  FastAPI /api/chat → Next.js UI: tool badges + citation chips
```

Verified live (before the free-tier daily quota ran out): the 4-tool chain
above, policy questions citing `[Returns and Refunds Policy :: Opened
Electronics]`, and simple stock lookups — all through the MCP wire.

---

## 7. Decision log (why we chose what we chose)

| Decision | Choice | Reason |
|---|---|---|
| Hosted vs local embeddings | OpenRouter free 2048-dim | metered internet (~3GB); local PyTorch needs ~5GB |
| No vector index | exact search | index cap is 2000 dims; 19 chunks is trivially fast |
| `vector(2048)` column | exact match to model dim | Postgres enforces it |
| Threshold 0.80 | measured gap | strong ~0.35–0.43, irrelevant ~0.94 |
| `temperature 0.2` | low/deterministic | citation + tool-call format adherence |
| `mcp==1.29.0` | pinned 1.x | 2.0.0 reworked API; FastMCP is the documented standard |
| Anchor "today" to `MAX(order_date)` | data is 2009–2010 | `now()` would return nothing |
| Upserts everywhere (`ON CONFLICT`) | merge, never duplicate | re-runs are idempotent; "swap data, ask again" demo |
| Identifiers normalized to str at the boundary | fixed 350k-row drop | Excel mixed int/str StockCode broke dict lookups |
| Tool results as formatted strings | text content blocks | the AI reasons over text, not tuples |
| Blocking HTTP inside async FastAPI | threadpool offload | sync `requests` would freeze the event loop |
| Agent toolset must cover real questions | added `top_sellers`, `search_products` | no discovery tool → agent stalls on "top seller?"/"by description" |
| Free-tier quota (50 req/day) | retries + `Retry-After` | hard daily caps need credits; can't be retried away |

---

## 8. The 350,000-row bug (your best interview anecdote)

When loading sales, a dict lookup keyed by `StockCode` silently dropped
**350,929 rows** (67%!). Root cause: Excel had the *same logical SKU* as both
an integer (`85048`) and a string (`'85048'`), so `dict["85048"]` missed the
int rows. Fix: `astype(str).str.strip()` — normalize every identifier to a
stripped string **at the ingestion boundary**, before any lookup.

Lesson to tell: *sanity-check counts, normalize at the boundary, and never trust
a pipeline that doesn't print its expected vs actual numbers.*

---

## 9. Failure → fix log (through Day 4)

| When | Failure | Fix |
|---|---|---|
| Day 2 | silent 350k-row drop | normalize IDs at boundary + count checks |
| Day 2 | HNSW index rejected (>2000 dims) | drop index, exact search, document it |
| Day 3 | model cited `[1]` not doc title | tighter citation rule in system prompt |
| Day 3 | 429 rate limit mid-demo | exponential backoff retries in `llm.py` |
| Day 4 | `mcp 2.0.0` broke FastAPI API | verify import surface; pin `mcp==1.29.0` |
| Day 4 | "last 30 days" returned nothing | anchor window to `MAX(order_date)` |
| Day 5 | agent stalled: "need the SKU" | added `top_sellers` discovery tool |
| Day 5 | agent couldn't resolve a product name | added `search_products` tool |
| Day 5 | one chat froze the whole API | threadpool offload + clean 503 + unwrap ExceptionGroup |
| Day 5 | free-tier daily quota hit (50/day) | retries + `Retry-After`; credits needed for demo |

---

## 10. Commands to verify everything still works

```bash
# from repo root, venv python
.venv/bin/python backend/search_policies.py "can customers return opened electronics?"
.venv/bin/python backend/rag_answer.py "do staff get a discount?"
.venv/bin/python backend/rag_answer.py "what is the best temperature to brew green tea?"   # refusal
.venv/bin/python backend/mcp_test_client.py    # 5 tools, live calls
.venv/bin/python backend/mcp_raw_client.py     # handshake + catalog + one call
```

Expected: the retrieval finds the right policy, the RAG answers cite
`[doc title :: section]`, the green-tea question is refused, and the MCP client
runs all 5 tools against real data.

---

## 11. What's left (the roadmap)

| Day | Work | Reuses |
|---|---|---|
| 5 ✅ | Agent loop (tool calling) + Next.js/shadcn chat UI with badges, citation chips, model selector | `llm.py` (tools), `mcp_test_client.py` pattern, FastAPI |
| 6 | Governance: `action_log` rows on every tool call, approval threshold, Telegram notify | `action_log`, `reorder_flags`, `telegram_messages` tables |
| 7 | Dockerize backend, deploy (Render/Railway), Vercel frontend, demo script, mock interview | everything |

The whole point of the architecture: **every later day is a thin wrapper on top
of the verified data layer** — the risky, novel parts (retrieval, grounding,
tool wire) are already proven.
