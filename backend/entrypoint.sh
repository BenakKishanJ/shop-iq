#!/usr/bin/env bash
# ShopIQ entrypoint: boot the embedded PostgreSQL, apply the schema, seed once
# (RAG policies + retail data), then run the FastAPI backend that also serves
# the statically exported frontend.
#
# Two database modes:
#   embedded  (default) — POSTGRES_HOST is unset/localhost: a Postgres server
#              is initialized and started inside this container.
#   external  — POSTGRES_HOST points at a managed database (Render Postgres,
#              Neon, Supabase, ...): the embedded server is skipped and the
#              schema + seed checks run against the external host instead.
set -euo pipefail

export PATH="${PGBIN:-$(pg_config --bindir)}:$PATH"
export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
export POSTGRES_USER="${POSTGRES_USER:-shopiq}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-shopiq}"
export POSTGRES_DB="${POSTGRES_DB:-shopiq}"
# libpq reads PGPASSWORD (not POSTGRES_PASSWORD); needed by psql/createdb in
# external mode, harmless under the embedded server's trust auth.
export PGPASSWORD="$POSTGRES_PASSWORD"

case "$POSTGRES_HOST" in
  ""|localhost|127.0.0.1) DB_MODE=embedded ;;
  *) DB_MODE=external ;;
esac
echo "[entry] database mode: $DB_MODE (host=$POSTGRES_HOST:$POSTGRES_PORT)"

PSQL_HOST_OPTS=(-h "$POSTGRES_HOST" -p "$POSTGRES_PORT")
if [ "$DB_MODE" = "embedded" ]; then
  PSQL_HOST_OPTS=(-h 127.0.0.1 -p "$POSTGRES_PORT")
fi

psql_db() {
  # Runs psql against the active database with extra args from "$@",
  # e.g. `psql_db -tAc "SELECT 1"` or `psql_db -f /app/schema.sql`.
  # -w: never prompt for a password (fails fast instead of hanging).
  psql -w "${PSQL_HOST_OPTS[@]}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 "$@"
}

if [ "$DB_MODE" = "embedded" ]; then
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
  runuser -u postgres -- pg_ctl -D "$PGDATA" \
    -o "-p $POSTGRES_PORT -c listen_addresses='127.0.0.1'" -w start

  for _ in $(seq 1 30); do
    if pg_isready -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" >/dev/null 2>&1; then break; fi
    sleep 1
  done

  if ! psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -tAc \
       "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'" | grep -q 1; then
    echo "[entry] creating database $POSTGRES_DB"
    createdb -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"
  fi
fi

echo "[entry] applying schema (idempotent)..."
psql_db -f /app/schema.sql

POLICY_COUNT=$(psql_db -tAc "SELECT count(*) FROM policy_documents")
if [ "$POLICY_COUNT" = "0" ]; then
  echo "[entry] seeding policy documents (RAG knowledge base)..."
  (cd /app && python ingest_policies.py) || echo "[entry] policy seed failed — continuing"
fi

PRODUCT_COUNT=$(psql_db -tAc "SELECT count(*) FROM products")
if [ "$PRODUCT_COUNT" = "0" ] && [ -f /app/data/raw/online_retail_II.xlsx ]; then
  echo "[entry] seeding retail data (takes a couple of minutes)..."
  (cd /app && python load_sales.py /app/data/raw/online_retail_II.xlsx) \
    || echo "[entry] retail data seed failed — continuing"
fi

echo "[entry] starting ShopIQ API on :${PORT:-8000}..."
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
