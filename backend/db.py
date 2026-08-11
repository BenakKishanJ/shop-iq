"""DB connection helper. Loads .env values, returns a psycopg connection."""
import os
from pathlib import Path
import psycopg
from dotenv import load_dotenv

load_dotenv()  # reads ../.env from the project root

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def get_conn():
    """Open a psycopg (v3) connection to the ShopIQ Postgres database.

    POSTGRES_SSLMODE controls TLS: use "require" for managed databases that
    mandate encryption (Neon, Supabase); "prefer" (the libpq default) falls
    back to a plaintext connection against the embedded local server.
    """
    return psycopg.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", "5432")),
        user=os.getenv("POSTGRES_USER", "shopiq"),
        password=os.getenv("POSTGRES_PASSWORD", "shopiq"),
        dbname=os.getenv("POSTGRES_DB", "shopiq"),
        sslmode=os.getenv("POSTGRES_SSLMODE", "prefer"),
    )


def apply_schema(conn):
    """Apply schema.sql to `conn`. Idempotent (every statement is guarded
    with IF NOT EXISTS or a DO block), so it can run against a brand-new
    database, an existing one, or every container boot without harm.

    Needed because the seed scripts (ingest_policies / load_sales) can run
    from a laptop against a fresh managed database (e.g. Neon) where the
    container entrypoint has never booted and created the tables yet.
    """
    conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"), None)
