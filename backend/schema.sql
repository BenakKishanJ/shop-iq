-- ShopIQ schema
-- Note: enable pgvector for the RAG tables (added on Day 2)
CREATE EXTENSION IF NOT EXISTS vector;

-- =========================================================
-- Structured retail data (seeded from Online Retail II)
-- =========================================================
CREATE TABLE IF NOT EXISTS products (
    product_id     SERIAL PRIMARY KEY,
    sku            TEXT UNIQUE NOT NULL,
    description    TEXT,
    unit_price     NUMERIC(10,2),
    initial_stock  INT DEFAULT 20000,          -- assumption documented in PRD
                                              -- (kept high so most SKUs stay in stock)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
    order_id     TEXT PRIMARY KEY,           -- Invoice number from the dataset
    customer_id  TEXT NOT NULL,
    order_date   TIMESTAMPTZ NOT NULL,
    country      TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
    id         SERIAL PRIMARY KEY,
    order_id   TEXT NOT NULL REFERENCES orders(order_id),
    product_id INT  NOT NULL REFERENCES products(product_id),
    quantity   INT  NOT NULL,
    unit_price NUMERIC(10,2),
    UNIQUE (order_id, product_id)
);

-- Derived stock view (PRD: current stock = initial_stock - SUM(quantity sold), floored at 0)
CREATE MATERIALIZED VIEW IF NOT EXISTS stock_view AS
    SELECT
        p.product_id,
        p.sku,
        p.description,
        p.unit_price,
        GREATEST(p.initial_stock - COALESCE(SUM(oi.quantity), 0), 0) AS current_stock
    FROM products p
    LEFT JOIN order_items oi ON oi.product_id = p.product_id
    GROUP BY p.product_id;

CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_orders_date         ON orders (order_date);

-- =========================================================
-- Unstructured documents (RAG corpus) — pgvector
-- =========================================================
CREATE TABLE IF NOT EXISTS policy_documents (
    doc_id      SERIAL PRIMARY KEY,
    title       TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,               -- pdf | docx | txt | seed
    raw_text    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id      SERIAL PRIMARY KEY,
    doc_id        INT NOT NULL REFERENCES policy_documents(doc_id) ON DELETE CASCADE,
    section_label TEXT,
    chunk_index   INT NOT NULL,
    content       TEXT NOT NULL,
    embedding     vector(2048)               -- matches llama-nemotron-embed-vl-1b-v2
);

-- HNSW index intentionally omitted: our embedding model (llama-nemotron-embed-vl-1b-v2)
-- outputs 2048 dims, but pgvector's HNSW (and IVFFlat) indexes cap at 2000 dims.
-- At our scale (a few thousand chunks) exact nearest-neighbour search is plenty fast.
-- If the corpus grew, we'd switch to a <=2000-dim embedder (e.g. text-embedding-3-small,
-- 1536 dims) to enable HNSW.
-- CREATE INDEX ... ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- =========================================================
-- Agent governance (Day 6)
-- =========================================================
-- CREATE TYPE has no IF NOT EXISTS; use a DO block for idempotency
DO $$
BEGIN
    CREATE TYPE action_status AS ENUM
        ('pending_approval','approved','rejected','executed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS action_log (
    action_id   SERIAL PRIMARY KEY,
    action_type TEXT NOT NULL,               -- 'tool_call' | 'action' | ...
    tool_name   TEXT NOT NULL,
    arguments   JSONB,
    result      JSONB,
    reasoning   TEXT,
    status      action_status DEFAULT 'executed',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
);

CREATE TABLE IF NOT EXISTS reorder_flags (
    flag_id            SERIAL PRIMARY KEY,
    product_id         INT NOT NULL REFERENCES products(product_id),
    suggested_quantity INT NOT NULL,
    reasoning          TEXT,
    action_id          INT REFERENCES action_log(action_id),
    status             TEXT DEFAULT 'flagged'
);

CREATE TABLE IF NOT EXISTS telegram_messages (
    message_id    BIGINT PRIMARY KEY,
    chat_id       TEXT,
    action_id     INT REFERENCES action_log(action_id),
    payload       JSONB,
    status        TEXT DEFAULT 'sent',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
