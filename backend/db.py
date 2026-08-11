"""DB connection helper. Loads .env values, returns a psycopg connection."""
import os
import psycopg
from dotenv import load_dotenv

load_dotenv()  # reads ../.env from the project root


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
