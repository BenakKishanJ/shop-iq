# Postgres, the Schema, and How Vectors Are Stored/Indexed/Retrieved

**Course:** ShopIQ Mentor Program — Day 2 core
**Goal:** Understand the exact database we built — every table, every constraint, how the `vector` column works physically, why we can't HNSW-index it, and the exact query patterns we use.

---

## 1. What We're Running

- **PostgreSQL 16** with the **pgvector 0.8.6** extension, in the Docker container `shopiq-db` (image `pgvector/pgvector:pg16`).
- Two databases: `shopiq` (real app data) and `shopiq_learn` (your scratch space).
- The whole design principle: **one datastore for both structured data and vectors** — no separate vector-DB service ("your stack, no sprawl").

---

## 2. The Schema — Table by Table

### 2.1 `products` — the catalog
```sql
CREATE TABLE IF NOT EXISTS products (
    product_id     SERIAL PRIMARY KEY,
    sku            TEXT UNIQUE NOT NULL,
    description    TEXT,
    unit_price     NUMERIC(10,2),
    initial_stock  INT DEFAULT 500,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
| Column | Type | Meaning |
|---|---|---|
| `product_id` | `SERIAL PRIMARY KEY` | Auto-incrementing integer ID; the internal key other tables reference |
| `sku` | `TEXT UNIQUE NOT NULL` | Stock code; unique so it can be the upsert conflict target |
| `description` | `TEXT` | Human-readable name |
| `unit_price` | `NUMERIC(10,2)` | Exact decimal (money-safe; never `FLOAT` for prices) |
| `initial_stock` | `INT DEFAULT 500` | The stated assumption: every product starts with 500 units |
| `created_at` | `TIMESTAMPTZ DEFAULT now()` | Auto timestamp |

**Count:** 4,011 rows.

### 2.2 `orders` — one row per invoice
```sql
CREATE TABLE IF NOT EXISTS orders (
    order_id     TEXT PRIMARY KEY,       -- Invoice number, e.g. '489434'
    customer_id  TEXT NOT NULL,
    order_date   TIMESTAMPTZ NOT NULL,
    country      TEXT
);
```
`order_id` is `TEXT`, not `INT` — invoice numbers are **identifiers**, and identifiers are strings (the mixed-type bug). **Count:** 19,040.

### 2.3 `order_items` — the link table (the many-to-many)
```sql
CREATE TABLE IF NOT EXISTS order_items (
    id         SERIAL PRIMARY KEY,
    order_id   TEXT NOT NULL REFERENCES orders(order_id),
    product_id INT  NOT NULL REFERENCES products(product_id),
    quantity   INT  NOT NULL,
    unit_price NUMERIC(10,2),
    UNIQUE (order_id, product_id)
);
```
- **Foreign keys** (`REFERENCES`) — Postgres enforces that every `order_id` exists in `orders` and every `product_id` in `products`. Referential integrity = you can't create orphan rows.
- `UNIQUE (order_id, product_id)` — no order lists the same product twice; also the conflict target for the item upsert.
- **Count:** 394,389.

### 2.4 `stock_view` — a materialized view (the derived stock)
```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS stock_view AS
    SELECT p.product_id, p.sku, p.description, p.unit_price,
           GREATEST(p.initial_stock - COALESCE(SUM(oi.quantity), 0), 0) AS current_stock
    FROM products p
    LEFT JOIN order_items oi ON oi.product_id = p.product_id
    GROUP BY p.product_id;
```
Dissected:
- `LEFT JOIN` — all products, even ones with no sales (they get NULL items).
- `SUM(oi.quantity) GROUP BY p.product_id` — units sold per product.
- `COALESCE(x, 0)` — NULL (never sold) → 0.
- `initial_stock − sold` → `GREATEST(..., 0)` floors at zero (no negative stock).
- **`MATERIALIZED`** = results are **stored on disk** (a snapshot table). Reads are fast; the snapshot goes stale, so after any data change you must:
  ```sql
  REFRESH MATERIALIZED VIEW stock_view;
  ```
  We call this at the end of every load. **A regular (non-materialized) view recomputes on every read; a materialized view is a stored result you refresh.**

### 2.5 `policy_documents` + `document_chunks` — the RAG corpus
```sql
CREATE TABLE IF NOT EXISTS policy_documents (
    doc_id      SERIAL PRIMARY KEY,
    title       TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,            -- pdf | docx | txt | seed
    raw_text    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id      SERIAL PRIMARY KEY,
    doc_id        INT NOT NULL REFERENCES policy_documents(doc_id) ON DELETE CASCADE,
    section_label TEXT,
    chunk_index   INT NOT NULL,
    content       TEXT NOT NULL,
    embedding     vector(2048)
);
```
- One document → many chunks. `ON DELETE CASCADE`: deleting a doc deletes its chunks automatically.
- **`embedding vector(2048)`** — this is the pgvector column. It holds a 2048-number vector matching our embedding model.
- **Count:** 6 documents, 19 chunks.

### 2.6 Governance tables (created now, used Day 6)
`action_log` (audit trail), `reorder_flags` (reorder actions), `telegram_messages` (notification audit). Note the `action_status` enum created via a `DO $$ ... EXCEPTION` block because **`CREATE TYPE` has no `IF NOT EXISTS`** in Postgres.

---

## 3. How Vectors Are Physically Stored

- `vector(n)` is a **custom type** provided by the pgvector extension. Physically it's stored like an array of `n` `float4` (single-precision) values — in a `vector` column each row holds one list of 2048 numbers.
- Inserting: pass a string literal or a Python list (psycopg serializes the list; the `::vector` cast tells Postgres how to interpret it):
  ```sql
  INSERT INTO document_chunks (doc_id, section_label, chunk_index, content, embedding)
  VALUES (1, 'Opened Electronics', 1, '...', '[0.043, 0.000, 0.020, ...]');
  ```
  In Python/psycopg we send the list and cast with `%s::vector`.
- Storage cost: 2048 × 4 bytes ≈ **8 KB per vector**. A few thousand chunks ≈ tens of MB. Trivial.
- Vectors can't exceed the column's declared dimension (`vector(2048)` rejects a 1024-dim value).
- The **length of the column's dimension must exactly equal the model's output dimension** — a dimension mismatch breaks queries.

---

## 4. How Vectors Are Indexed — and Why Ours Aren't

Indexing makes nearest-neighbor search fast at scale by avoiding a full scan.

### The two pgvector index types
| Index | How it works | Notes |
|---|---|---|
| **HNSW** | Builds a graph of near-neighbors (hierarchical navigable small-world) | **Modern default.** Excellent quality/speed, supports incremental inserts, uses more memory |
| **IVFFlat** | Clusters vectors; search only probes nearby clusters | Older; needs data present *before* building; slightly less accurate |

### Operator classes (which metric the index serves)
```sql
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops);  -- for <=>
CREATE INDEX ... USING hnsw (embedding vector_l2_ops);      -- for <->
CREATE INDEX ... USING hnsw (embedding vector_ip_ops);      -- for <#>
```
`vector_cosine_ops` = "index optimized for the cosine distance operator."

### The 2000-dimension cap (our story)
pgvector's HNSW **and** IVFFlat indexes support **at most 2000 dimensions**. Our model outputs **2048**. Postgres rejected the index creation:
```
ERROR: column cannot have more than 2000 dimensions for hnsw index
```
**The `vector` column stores 2048 fine — only the index refuses.** So our schema has no vector index; we rely on **exact nearest-neighbor search** (a full scan computing distance per row).

**When exact search is fine:** at a few thousand rows, scanning is sub-millisecond. **When you need an index:** millions of vectors, or strict latency at scale — then switch the embedder to a ≤2000-dim model (e.g. `text-embedding-3-small`, 1536) and add the HNSW index.

---

## 5. How Vectors Are Retrieved — the query patterns

### 5.1 Nearest-neighbor search (our `search_policies.py` core)
```sql
SELECT p.title, c.section_label, c.content,
       (c.embedding <=> %s::vector) AS dist
FROM document_chunks c
JOIN policy_documents p USING (doc_id)
ORDER BY c.embedding <=> %s::vector
LIMIT 5;
```
- `<=>` cosine distance; `ORDER BY ... LIMIT k` = nearest k first.
- `%s::vector` — psycopg placeholder + Postgres cast: "treat this Python list as a pgvector vector."
- `USING (doc_id)` — shorthand join on the column both tables share.
- Result rows have a `dist` column — *smaller = more similar*.

### 5.2 The grounding/threshold check
```sql
-- is ANY chunk close enough? if not, refuse to answer
SELECT MIN(c.embedding <=> %s::vector) FROM document_chunks c;
```
If the minimum distance exceeds a tuned threshold → answer "No relevant policy found."

### 5.3 The upsert patterns (how ingestion stays idempotent)
```sql
-- products: insert, or update the existing row; EXCLUDED = the row you tried to insert
INSERT INTO products (sku, description, unit_price, initial_stock)
VALUES (%s, %s, %s, %s)
ON CONFLICT (sku) DO UPDATE
  SET description = EXCLUDED.description,
      unit_price  = EXCLUDED.unit_price;

-- orders: insert, or do nothing (headers shouldn't duplicate)
INSERT INTO orders (order_id, customer_id, order_date, country)
VALUES (%s, %s, %s, %s)
ON CONFLICT (order_id) DO NOTHING;

-- items: insert, or add quantities (dirty-data safety)
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
VALUES (%s, %s, %s, %s)
ON CONFLICT (order_id, product_id) DO UPDATE
  SET quantity = order_items.quantity + EXCLUDED.quantity;

-- documents: insert or replace; RETURNING hands back the id either way
INSERT INTO policy_documents (title, source_type, raw_text)
VALUES (%s, 'seed', %s)
ON CONFLICT (title) DO UPDATE SET raw_text = EXCLUDED.raw_text
RETURNING doc_id;
```
`ON CONFLICT (col)` **requires a unique constraint on `col`** — that's why `sku` and `order_id` are `UNIQUE`/PK.

### 5.4 Verifying a load (the habit that caught the bug)
```sql
SELECT 'products' AS what, COUNT(*) FROM products
UNION ALL SELECT 'orders',    COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items;
```
Compare to your expectations; **a wrong-looking number is your best bug detector.**

---

## 6. Transactions — Why Nothing Half-Loads

```python
with conn.transaction():      # psycopg idiom: auto-commit on success, rollback on error
    ... all the inserts ...
```
- **Atomicity:** all statements succeed together or none do. An error mid-way rolls everything back — the DB is never left half-loaded.
- The alternative idiom: run statements, then `conn.commit()` at the end (used in `ingest_policies.py`). Same guarantee, explicit control.

---

## 7. The psql Side (how you'd inspect all of this)

```bash
docker exec -it shopiq-db psql -U shopiq -d shopiq
```
```sql
\dt                       -- list tables
\d order_items            -- describe columns, types, FKs, indexes
\dm                       -- list materialized views
\d+ stock_view            -- the view's definition
\di                       -- list indexes
SELECT * FROM stock_view WHERE current_stock = 0 LIMIT 5;
SELECT p.title, c.section_label, c.content,
       ROUND((c.embedding <=> '[0.1,0.2,...]'::vector)::numeric, 4) AS dist
FROM document_chunks c JOIN policy_documents p USING (doc_id)
ORDER BY dist LIMIT 3;     -- hand-run the similarity search
```

---

## 8. "This is what you say in the interview"

- "All state lives in one Postgres instance: relational tables for products/orders, a materialized stock view for derived stock, and a `vector(2048)` column on `document_chunks` for retrieval — no separate vector database."
- "Stock is a materialized view (`initial_stock − sales`, floored at 0) refreshed after each ingestion — a stated assumption, not hidden."
- "Vectors are stored in a pgvector column and queried with `ORDER BY embedding <=> :vec LIMIT k`. I skipped the HNSW index because our free embedder is 2048-dim and pgvector caps indexes at 2000; exact search is sub-millisecond at our corpus size."
- "Every ingestion path is idempotent via `ON CONFLICT` upserts, and every load runs in one transaction, so re-running a load or a bad upload can't corrupt the dataset."

---

## 9. Practice Drills

1. `\d order_items` — name the FK columns, the unique constraint, and the index.
2. Write the SQL for "top 10 products by revenue." (Hint: `SUM(quantity * unit_price) GROUP BY product_id ORDER BY ...`)
3. Write the upsert that adds an item quantity instead of duplicating a row.
4. Explain in one sentence why `ON CONFLICT (sku)` requires `UNIQUE (sku)`.
5. What happens to `stock_view` if you insert 100 new order_items and forget to refresh it? Why?
6. Create a scratch table in `shopiq_learn` with `vector(4)`, insert three points, and rank them against a query using `<=>`. Confirm you can do it without looking at notes.
7. If we switched to a 1536-dim model, write the two statements needed to (a) change the column and (b) enable HNSW.
