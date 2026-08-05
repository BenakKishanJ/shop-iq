# PostgreSQL & SQL — Complete Reference Notes

**Course:** ShopIQ Mentor Program — Day 1 (Environment)
**Audience:** Engineer with Oracle/MariaDB experience, SQL a bit rusty
**Goal:** Refresh SQL fundamentals, learn Postgres-specific features and psql meta-commands, and build toward the exact patterns ShopIQ uses (SERIAL, UPSERT, materialized views, pgvector).

---

## 1. What Is PostgreSQL?

PostgreSQL ("Postgres") is the most respected open-source relational database. Key facts:

- **ACID compliant** — transactions with full integrity guarantees.
- **Rich type system** — JSONB, arrays, ranges, enums, and crucially **vectors** (via pgvector).
- **Powerful indexing** — B-tree, GIN, GiST, BRIN, HASH, plus full-text search.
- **Extensible** — extensions like `pgvector` plug in cleanly (`CREATE EXTENSION vector;`).
- Oracle's `v$`-style system views → Postgres has `information_schema` (standard) and `pg_catalog` (internal).

**Our connection** (psql isn't installed on the host; we run it *inside* the container — the tooling ships with the DB):

```bash
docker exec -it shopiq-db psql -U shopiq -d shopiq
```

`-U shopiq` = user, `-d shopiq` = database. You get the `shopiq=#` prompt.

---

## 2. Coming From Oracle / MariaDB — the Translation Table

This is the fastest way for you to re-anchor. Postgres is far closer to MariaDB than to Oracle, but has its own quirks.

| Concept | Oracle | MariaDB / MySQL | PostgreSQL |
|---|---|---|---|
| Variable-length text | `VARCHAR2(n)` | `VARCHAR(n)`, `TEXT` | `VARCHAR(n)`, `TEXT` (no length limit on `TEXT`) |
| Integer | `NUMBER(10)` | `INT`, `BIGINT`, `TINYINT` | `INT`/`INTEGER`, `BIGINT`, `SMALLINT`; no `TINYINT` |
| Decimal | `NUMBER(10,2)` | `DECIMAL(10,2)` | `NUMERIC(10,2)` / `DECIMAL` |
| Boolean | No native | `TINYINT(1)` / `BOOLEAN` | `BOOLEAN` (true/false) |
| Auto-increment PK | `SEQUENCE` + trigger | `AUTO_INCREMENT` | `SERIAL` (old) or `GENERATED ... AS IDENTITY` (standard) |
| Select without a table | `SELECT ... FROM DUAL` | `SELECT ...` | `SELECT ...` (no DUAL needed) |
| Current timestamp | `SYSDATE` | `NOW()` | `NOW()` / `CURRENT_TIMESTAMP` |
| String concat | `\|\|` | `CONCAT()`, `\|\|` | `\|\|` and `CONCAT()` |
| Null replacement | `NVL(a, b)` | `IFNULL(a, b)` | `COALESCE(a, b)` |
| Row limit | `ROWNUM` / `FETCH FIRST` | `LIMIT` | `LIMIT` / `OFFSET` / `FETCH FIRST` |
| String quotes | single quotes | single quotes (double = identifiers) | single quotes (**double quotes = identifiers only**) |
| Identifier quotes | `"col"` | backticks `` `col` `` | `"col"` |
| Upsert | `MERGE INTO` | `INSERT ... ON DUPLICATE KEY UPDATE` | `INSERT ... ON CONFLICT (col) DO UPDATE/NOTHING` |
| List tables | `SELECT * FROM user_tables` | `SHOW TABLES` | `\dt` (psql) or query `information_schema` |
| Describe table | `DESC table` | `DESCRIBE table` | `\d table` (psql) |
| Index introspection | `user_indexes` | `SHOW INDEX FROM` | `\di` (psql) |
| Stored procedures | PL/SQL | stored procedures | PL/pgSQL (similar feel) |
| Storage engine choice | — | `ENGINE=InnoDB` | One engine; `CREATE INDEX` is separate |
| Case sensitivity | table names case-sensitive | table names case-sensitive on Linux | **identifiers folded to lowercase** unless quoted |
| Group-by strictness | strict | loose | **strict** (non-aggregated columns must appear in GROUP BY or be functionally dependent) |

**The three biggest gotchas to remember:**

1. **Double quotes = identifiers, never strings.** `SELECT "hello"` looks up a column named `hello`, it does not return the literal `hello`. Use single quotes for string literals.
2. **Unquoted identifiers are lowercased.** `CREATE TABLE Products` creates `products` (lowercase). If you use mixed case, you must always quote it. Best practice: **always lowercase, snake_case identifiers.**
3. **Strict GROUP BY.** `SELECT sku, SUM(qty) FROM order_items GROUP BY sku;` is fine; `SELECT sku, description, SUM(qty) ... GROUP BY sku;` errors unless `description` is functionally dependent on `sku` or included in the group.

---

## 3. psql Meta-Commands (the `\` commands — psql's superpower)

psql is Postgres's interactive client. `\` commands are *client* features, not SQL — they help you inspect and format.

### 3.1 The essentials
```sql
\l                       -- list databases
\c dbname                -- connect to another database
\dn                      -- list schemas
\dt                      -- list tables in current schema
\dt public.*             -- list tables in a specific schema
\d table                 -- DESCRIBE: columns, types, defaults, constraints, indexes
\d+ table                -- describe with more detail (storage, size, comments)
\di                      -- list indexes
\dv                      -- list views
\dm                      -- list materialized views
\df                      -- list functions
\dT                      -- list types
\du                      -- list roles/users
\q                       -- quit
```

### 3.2 Formatting & output control
```sql
\x                       -- toggle EXPANDED display (one field per line, for wide tables)
\x auto                  -- expanded only when the table is too wide
\pset null 'NULL'        -- display NULLs visibly (default is empty = confusing)
\pset border 2           -- pretty box borders
\timing                  -- show how long each query took (habit to always have on!)
\echo hello              -- print text (useful inside scripts)
\watch 5                 -- re-run the previous query every 5 seconds (live monitoring!)
```

### 3.3 Scripting & I/O
```sql
\i /path/to/file.sql     -- run SQL from a file
\o /path/to/out.txt      -- redirect query output to a file
\o                      -- stop redirecting
\copy table TO '/tmp/x.csv' DELIMITER ',' CSV HEADER   -- export (CLIENT-side)
\copy table FROM '/tmp/x.csv' DELIMITER ',' CSV HEADER -- import
```

### 3.4 Variables (advanced but very useful)
```sql
\set myvar 'hello'       -- define a variable
SELECT :'myvar';         -- use it (with quotes)
\set VERBOSITY verbose   -- more detailed error messages
\gset                   -- store query result columns as variables
```

### 3.5 Non-interactive usage (scripts / automation)
```bash
psql -U shopiq -d shopiq -c "SELECT 1;"          # run one query, exit
psql -U shopiq -d shopiq -f queries.sql          # run a file
psql -U shopiq -d shopiq -c "SELECT * FROM t;" -x   # expanded mode
```

---

## 4. SQL Refresher — Core (Postgres-flavored)

### 4.1 Selecting & filtering
```sql
SELECT sku, description, unit_price
FROM products
WHERE unit_price > 10
  AND initial_stock IS NOT NULL      -- NULL checks use IS NULL / IS NOT NULL
ORDER BY unit_price DESC             -- also: ASC, and NULLS FIRST / NULLS LAST
LIMIT 10 OFFSET 20;                  -- pagination: skip 20, take 10
```
- `IS NULL` / `IS NOT NULL` — you can never use `= NULL`.
- `IN (..)`, `BETWEEN a AND b`, `LIKE 'SKU-%'`, `ILIKE '%MUG%'` (case-insensitive).
- `DISTINCT` / `DISTINCT ON (col)` (Postgres extra: one row per value of `col`).

### 4.2 Joins
```sql
SELECT o.order_id, oi.quantity, p.sku
FROM orders o
JOIN order_items oi ON o.order_id = oi.order_id
JOIN products p      ON p.product_id = oi.product_id;
```
- `INNER JOIN` (just `JOIN`) — matching rows only.
- `LEFT JOIN` — all left rows, `NULL`s for unmatched right.
- `RIGHT JOIN`, `FULL OUTER JOIN` — less common but know they exist.
- Self-join: join a table to itself with different aliases.

### 4.3 Aggregation
```sql
SELECT p.product_id,
       COUNT(*)          AS line_count,
       SUM(oi.quantity)  AS units_sold,
       AVG(oi.unit_price) AS avg_price
FROM order_items oi
JOIN products p ON p.product_id = oi.product_id
GROUP BY p.product_id
HAVING SUM(oi.quantity) > 100     -- filter on aggregates (WHERE can't do this)
ORDER BY units_sold DESC;
```
Order of evaluation mentally: **WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT.**

### 4.4 Common functions
```sql
COALESCE(a, b, 0)          -- first non-NULL
NULLIF(a, b)               -- NULL if a = b (useful to avoid div-by-zero)
ROUND(x, 2), ABS(x), GREATEST(a,b), LEAST(a,b)
UPPER(s), LOWER(s), LENGTH(s), SUBSTRING(s FROM 1 FOR 3), TRIM(s)
EXTRACT(YEAR FROM o.order_date)     -- also MONTH, DAY, DOW
o.order_date + INTERVAL '7 days'    -- date arithmetic
TO_CHAR(o.order_date, 'YYYY-MM-DD') -- formatting
CAST(x AS NUMERIC) / x::NUMERIC     -- casting (:: is Postgres shorthand)
```

### 4.5 Subqueries & CTEs
```sql
-- scalar subquery
SELECT sku, (SELECT MAX(unit_price) FROM products) FROM products;

-- IN subquery
SELECT * FROM products WHERE product_id IN (SELECT product_id FROM order_items);

-- Common Table Expression (CTE) — the modern, readable way to build complex queries
WITH units_sold AS (
  SELECT product_id, SUM(quantity) AS total
  FROM order_items
  GROUP BY product_id
)
SELECT p.sku, u.total
FROM products p
JOIN units_sold u USING (product_id)
WHERE u.total > 100;
```
CTEs also support **recursive queries** (`WITH RECURSIVE`) — the standard tool for trees/hierarchies.

---

## 5. SQL Refresher — Advanced (interview-ready)

### 5.1 Window functions (a huge Postgres strength)
Compute a value across a *set of related rows* without collapsing them (unlike GROUP BY).

```sql
SELECT sku, order_date, quantity,
       ROW_NUMBER() OVER (PARTITION BY sku ORDER BY order_date DESC) AS rn,
       RANK()       OVER (ORDER BY quantity DESC)                   AS rank,
       SUM(quantity) OVER (PARTITION BY sku ORDER BY order_date)    AS running_total,
       LAG(quantity) OVER (PARTITION BY sku ORDER BY order_date)    AS prev_quantity,
       AVG(quantity) OVER (PARTITION BY sku)                        AS avg_per_sku
FROM order_items;
```
- `OVER (PARTITION BY x ORDER BY y)` — the window: group by `x`, order by `y`.
- `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `LAG()`/`LEAD()`, `SUM() OVER ...` (running totals), `NTILE()`, `FIRST_VALUE()`.
- **Real ShopIQ use:** "top-selling products per month", running sales totals for `sales_trend`.

### 5.2 UPSERT — `INSERT ... ON CONFLICT`
The pattern ShopIQ's ingestion uses every time it ingests a file (insert-or-update, never duplicate).

```sql
INSERT INTO products (sku, description, unit_price)
VALUES ('SKU-001', 'Ceramic mug', 12.50)
ON CONFLICT (sku) DO UPDATE
SET description = EXCLUDED.description,
    unit_price  = EXCLUDED.unit_price;
```
- `ON CONFLICT (col)` requires a unique constraint/index on `col`.
- `EXCLUDED` refers to the row you *tried* to insert.
- `ON CONFLICT (sku) DO NOTHING` — skip silently.

### 5.3 Transactions
```sql
BEGIN;                                  -- also: START TRANSACTION
  INSERT ...;
  UPDATE ...;
COMMIT;                                 -- make it permanent
-- or on error: ROLLBACK;               -- undo everything since BEGIN
```
- **Atomicity:** all-or-nothing.
- Postgres sessions auto-commit single statements unless you're inside `BEGIN`.
- `SAVEPOINT sp1; ... ROLLBACK TO sp1;` — partial rollback within a transaction.

### 5.4 Indexes & query performance (the interview question)
```sql
CREATE INDEX idx_order_items_product ON order_items (product_id);
CREATE UNIQUE INDEX idx_products_sku ON products (sku);       -- enforces uniqueness
CREATE INDEX idx_orders_date ON orders (order_date DESC);
CREATE INDEX idx_products_desc ON products USING GIN (to_tsvector('english', description)); -- full-text
CREATE INDEX idx_products_lower_sku ON products (LOWER(sku)); -- function index for ILIKE tricks
```
**When do indexes help?** Columns used in `WHERE`, `JOIN`, `ORDER BY`, uniqueness. Each index slows *writes* a bit (must be updated), so index deliberately.

**EXPLAIN — how to actually read a query plan:**
```sql
EXPLAIN SELECT * FROM order_items WHERE product_id = 5;
EXPLAIN ANALYZE SELECT ...;   -- actually runs it and reports real timings
```
Look for: `Seq Scan` (full table scan — bad on big tables) vs `Index Scan` (good). In ShopIQ you'll see this when we tune the stock/trend queries.

### 5.5 Views & Materialized Views
```sql
-- Regular view: a saved query; always live, no storage cost, recomputed each access
CREATE VIEW product_stock AS
  SELECT p.product_id, p.initial_stock - COALESCE(SUM(oi.quantity),0) AS current_stock
  FROM products p LEFT JOIN order_items oi ON oi.product_id = p.product_id
  GROUP BY p.product_id;

SELECT * FROM product_stock;   -- just uses the view

-- Materialized view: results STORED on disk; fast reads, but you must refresh
CREATE MATERIALIZED VIEW product_stock_mv AS
  SELECT p.product_id, p.initial_stock - COALESCE(SUM(oi.quantity),0) AS current_stock
  FROM products p LEFT JOIN order_items oi ON oi.product_id = p.product_id
  GROUP BY p.product_id;

REFRESH MATERIALIZED VIEW product_stock_mv;
```
**This is EXACTLY the `StockView` from the ShopIQ design doc** — a materialized view refreshed after each ingestion. "Materialized" = stored; "view" = a query in disguise.

### 5.6 JSONB (Postgres's flexible column)
```sql
CREATE TABLE events (id SERIAL, payload JSONB);
INSERT INTO events (payload) VALUES ('{"tool": "check_stock", "args": {"product": "SKU-001"}}');
SELECT payload->>'tool' FROM events;        -- -> returns JSON, ->> returns text
SELECT * FROM events WHERE payload @> '{"tool": "flag_reorder"}';
```
ShopIQ's `ActionLog` uses a `JSONB` column for tool arguments/results.

### 5.7 Enums, arrays, and serials (DML level)
```sql
CREATE TYPE action_status AS ENUM ('pending_approval','approved','rejected','executed');
CREATE TABLE actions (
  action_id SERIAL PRIMARY KEY,
  status action_status DEFAULT 'pending_approval'
);
CREATE TABLE tags (id SERIAL, labels TEXT[]);          -- array type
INSERT INTO tags (labels) VALUES (ARRAY['a','b']);
```

---

## 6. Backup & Restore (psql family)

```bash
# Logical dump of one database (schema + data)
docker exec shopiq-db pg_dump -U shopiq -d shopiq > shopiq_backup.sql

# Restore
docker exec -i shopiq-db psql -U shopiq -d shopiq < shopiq_backup.sql

# Schema only / data only
docker exec shopiq-db pg_dump -U shopiq -d shopiq --schema-only > schema.sql
docker exec shopiq-db pg_dump -U shopiq -d shopiq --data-only > data.sql
```

---

## 7. Schema Management Patterns for ShopIQ

ShopIQ's tables are described in the design doc; these are the patterns you'll use:

```sql
-- Products: SERIAL auto-increment PK + UNIQUE sku (target of ON CONFLICT)
CREATE TABLE products (
  product_id   SERIAL PRIMARY KEY,
  sku          TEXT UNIQUE NOT NULL,
  description  TEXT,
  unit_price   NUMERIC(10,2),
  initial_stock INT DEFAULT 500
);

-- Orders: FK relationships
CREATE TABLE orders (
  order_id   SERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL,
  order_date  TIMESTAMPTZ NOT NULL,
  country    TEXT
);
CREATE TABLE order_items (
  order_id  INT NOT NULL REFERENCES orders(order_id),
  product_id INT NOT NULL REFERENCES products(product_id),
  quantity  INT NOT NULL,
  unit_price NUMERIC(10,2),
  PRIMARY KEY (order_id, product_id)
);

-- Materialized stock view (the PRD's StockView)
CREATE MATERIALIZED VIEW stock_view AS
  SELECT p.product_id,
         GREATEST(p.initial_stock - COALESCE(SUM(oi.quantity), 0), 0) AS current_stock
  FROM products p
  LEFT JOIN order_items oi ON oi.product_id = p.product_id
  GROUP BY p.product_id;

REFRESH MATERIALIZED VIEW stock_view;
```

---

## 8. Practice Drills

1. Connect: `docker exec -it shopiq-db psql -U shopiq -d shopiq`, run `\l`, `\dt`, `SELECT version();`, `\q`.
2. Turn on `\timing` permanently (add it to a `.psqlrc` file later).
3. Build the three `products` / `orders` / `order_items` tables above in a **scratch database** (keep `shopiq` clean for the real app).
4. Insert ~10 products, ~5 orders with line items; write the join query that shows each order's SKUs and quantities.
5. Write the `stock_view` materialized view; refresh it; confirm `current_stock` equals `initial_stock - SUM(quantity)`.
6. Practice an upsert: insert `SKU-001` twice with `ON CONFLICT (sku) DO UPDATE` and confirm the row is not duplicated.
7. Write a window query that ranks your products by units sold (`SUM(quantity) OVER (PARTITION BY product_id)` or a `ROW_NUMBER()`).
8. Run `EXPLAIN ANALYZE` on a join and identify whether Postgres uses a `Seq Scan` or `Index Scan`.
