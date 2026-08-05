# Day 2 — Real Data, Real Embeddings

**Course:** ShopIQ Mentor Program
**Goal:** Load the real store dataset, derive stock, and build the real embedding + vector-search pipeline that RAG will sit on top of.

---

## 1. Big Picture

Day 1 gave you theory and a toy 3-dim vector demo. Day 2 makes it real:

- **Structured half:** Online Retail II (525k transaction rows) cleaned and loaded into Postgres; `stock_view` materialized view derived.
- **Unstructured half:** six self-authored policy documents chunked, embedded via OpenRouter, and stored in `document_chunks` with a real 2048-dim vector column.
- **Proof:** a question with *zero shared words* with any document still retrieves the right policy — that's semantic search.

**What you can now say:** "I ingested a real 525k-row retail dataset and a policy corpus, derived a stock view, and ran real vector similarity search over both."

---

## 2. Concept: Data cleaning — "Garbage in, garbage out"

Real datasets are messy. Our pipeline cleaned 525,461 rows → **407,050 usable**:

| Problem | How we handled it |
|---|---|
| Cancellations coded as **negative Quantity** | dropped rows where `Quantity <= 0` |
| **Null customer IDs** (~20% of the dataset!) | dropped rows with missing customer |
| Accounting rows, not products (`ADJUST2`, `BANK CHARGES`) | dropped by StockCode prefix |
| Missing descriptions | dropped (empty Description is useless for sales_trend) |
| **Mixed-type identifiers** | **normalized to strings** (see the bug below) |

### The bug that ate 350k rows (read this carefully)

- Excel stores numeric-looking SKUs (`85048`) as **numbers**, alphanumeric ones (`79323P`) as **text**.
- pandas preserves that: the `StockCode` column is a *mix* of `int` and `str`.
- Our first loader inserted products (coerced to text) but looked up `sku_to_id` with the *raw* value → `int 85048` vs `str '85048'` → **dict lookup silently returned None → 350,929 rows never inserted.** No error, no crash — data just vanished.

**The golden rule:** *normalize identifiers to strings at the boundary, the moment data enters the system.* Never assume a spreadsheet's types.

```python
df["StockCode"]  = df["StockCode"].astype(str).str.strip()
df["Invoice"]    = df["Invoice"].astype(str).str.strip()
df["Customer ID"] = df["Customer ID"].astype(str).str.split(".").str[0]  # "13085.0" -> "13085"
```

This is a famous real-world class of bug — and a great interview story about *verifying load counts* (we caught it because `order_items: 54,691` didn't match the expected ~394k).

---

## 3. Concept: Embeddings in practice (hosted)

- An **embedding model** outputs a fixed-size vector per text; ours returns **2048 dimensions**.
- You call it over HTTP (same style as chat) — no local model, no download, tiny JSON payloads. **Perfect for a metered connection.**
- **Free-tier lesson:** rate limits apply per request, so **batch many texts into one request** (`"input": [t1, t2, ...]`) instead of N separate calls. Our ingest embeds 20 chunks per request.
- **Consistency rule:** the *same* model must embed stored chunks *and* queries, or their coordinates live in different spaces and distance is meaningless.

### The HNSW 2000-dimension limit (a pgvector gotcha)

- pgvector's HNSW (and IVFFlat) indexes cap at **2000 dimensions**; our free embedder outputs **2048** → the index creation *failed* with a clear Postgres error.
- **Our choice:** keep the free 2048-dim model, skip the index, use **exact (brute-force) nearest-neighbor search** — sub-millisecond at a few thousand chunks.
- **Interview talking point:** "At our corpus size, exact search is plenty fast; if we scaled up we'd switch to a ≤2000-dim embedder like text-embedding-3-small (1536 dims) to unlock HNSW — a documented tradeoff, not an accident."
- *The vector column still holds 2048 dims fine — only the index has the limit.*

---

## 4. Code Walkthrough

### `backend/schema.sql`
- `products`, `orders`, `order_items` per the design doc (`SERIAL` PKs, `UNIQUE` sku, FKs).
- `stock_view` **materialized view**: `GREATEST(initial_stock - SUM(quantity), 0)` — floored at zero, refreshed after each ingest.
- `policy_documents` + `document_chunks(embedding vector(2048))`.
- Governance tables staged for Day 6 (`action_log`, `reorder_flags`, `telegram_messages`).

### `backend/load_sales.py`
`parse → clean → upsert → refresh` in one path (this exact logic later powers the `/data` upload page).

### `backend/embeddings.py`
```python
def embed_texts(texts):            # POST /embeddings, batched, sorted by index
```
Returns a list of vectors. Reused by ingestion and search — **one embed path, both directions.**

### `backend/policy_seed.py` → `backend/ingest_policies.py`
- Seed docs as `(section_title, body)` pairs → chunker produces citable chunks.
- `INSERT ... ON CONFLICT (title) DO UPDATE` replaces a document's chunks on re-ingest (never duplicates).
- Embeds in batches of 20, inserts with `doc_id` + `section_label`.

### `backend/search_policies.py`
```python
ORDER BY c.embedding <=> %s::vector LIMIT k
```
The entire retrieval half of RAG. `%s::vector` casts the Python list to pgvector's type.

---

## 5. "This is what you say in the interview"

- **On data quality:** "I loaded a real 525k-row retail dataset. The loader exposed a classic spreadsheet trap — mixed int/string identifiers — which silently dropped 350k rows until I normalized identifiers to strings at the boundary and verified counts."
- **On the stock model:** "Current stock is derived — `initial_stock − cumulative sales`, floored at zero — because the dataset has no live inventory field. It's a stated assumption, not hidden."
- **On retrieval:** "Policy text is chunked by section, embedded via OpenRouter (2048-dim, free, batched for rate limits), and searched by cosine distance. A question with no shared vocabulary still retrieves the right policy — that's meaning-based search."
- **On the index tradeoff:** see the HNSW point above.

---

## 6. Pitfalls We Hit (and how to avoid them)

1. **Mixed-type identifiers** → normalize at the boundary, always.
2. **HNSW 2000-dim cap** → know your embedder's dimension before choosing an index.
3. **Free-tier rate limits** → batch embeddings; retry with backoff in production.
4. **`CREATE TYPE ... IF NOT EXISTS` doesn't exist** → use a `DO $$ ... EXCEPTION` block.
5. **`docker exec -i ... -f - < file`** — psql reads stdin; `-v ON_ERROR_STOP=1` makes it fail loudly.
6. **Verify counts after any load** — a wrong-looking number is your best bug detector.

---

## 7. Practice Questions

1. Why did the first loader drop 350k rows without erroring? What one-line fix prevents it?
2. Why batch embeddings instead of one-per-request?
3. What's the difference between storing 2048-dim vectors and indexing them with HNSW?
4. Write the SQL to find the 10 worst-selling products by units.
5. Why must the query text and the stored chunks be embedded by the *same* model?
6. In `search_policies.py`, what does `%s::vector` do and why is it needed?
