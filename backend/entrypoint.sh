#!/usr/bin/env bash
# Single-image entrypoint: boot the embedded PostgreSQL, apply the schema,
# seed once (RAG policies + retail data), then run the FastAPI backend that
# also serves the statically exported frontend.
set -euo pipefail

export PATH="${PGBIN:-$(pg_config --bindir)}:$PATH"
export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export POSTGRES_USER="${POSTGRES_USER:-shopiq}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-shopiq}"
export POSTGRES_DB="${POSTGRES_DB:-shopiq}"

echo "[entry] PostgreSQL data dir: $PGDATA"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[entry] initializing PostgreSQL data directory..."
  install -d -o postgres -g postgres "$PGDATA"
  # --encoding=UTF8 is essential: without it initdb defaults to SQL_ASCII in a
  # locale-less slim image, and psycopg then returns TEXT as bytes, breaking
  # the loader's str-keyed lookups (order_items would silently load 0 rows).
  runuser -u postgres -- initdb -D "$PGDATA" -U "$POSTGRES_USER" \
    --auth=trust --encoding=UTF8 --locale=C
fi

echo "[entry] starting PostgreSQL..."
runuser -u postgres -- pg_ctl -D "$PGDATA" -o "-p 5432 -c listen_addresses='127.0.0.1'" -w start

for _ in $(seq 1 30); do
  if pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" >/dev/null 2>&1; then break; fi
  sleep 1
done

if ! psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'" | grep -q 1; then
  echo "[entry] creating database $POSTGRES_DB"
  createdb -h 127.0.0.1 -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"
fi

echo "[entry] applying schema..."
psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f /app/schema.sql

POLICY_COUNT=$(psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM policy_documents")
if [ "$POLICY_COUNT" = "0" ]; then
  echo "[entry] seeding policy documents (RAG knowledge base)..."
  (cd /app && python ingest_policies.py) || echo "[entry] policy seed failed — continuing"
fi

PRODUCT_COUNT=$(psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM products")
if [ "$PRODUCT_COUNT" = "0" ] && [ -f /app/data/raw/online_retail_II.xlsx ]; then
  echo "[entry] seeding retail data (takes a couple of minutes)..."
  (cd /app && python load_sales.py /app/data/raw/online_retail_II.xlsx) \
    || echo "[entry] retail data seed failed — continuing"
fi

echo "[entry] starting ShopIQ API on :8000..."
exec uvicorn main:app --host 0.0.0.0 --port 8000
