"""Embedding client: text -> vectors via OpenRouter /embeddings.

Batching: we send many texts in ONE request because free-tier embedding
endpoints have per-request rate limits. One request per 20 texts is far
more efficient than 20 requests of 1 text.
"""
import os
import requests
from dotenv import load_dotenv

load_dotenv()

EMBED_MODEL = os.getenv("EMBEDDING_MODEL", "nvidia/llama-nemotron-embed-vl-1b-v2:free")
BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")


def embed_texts(texts: list[str], model: str = EMBED_MODEL) -> list[list[float]]:
    """Embed a list of texts; returns a list of vectors (same order as input)."""
    resp = requests.post(
        f"{BASE_URL}/embeddings",
        headers={
            "Authorization": f"Bearer {os.getenv('OPENROUTER_API_KEY')}",
            "Content-Type": "application/json",
        },
        json={"model": model, "input": texts, "encoding_format": "float"},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    # data is ordered by index, but re-sort defensively
    return [d["embedding"] for d in sorted(data, key=lambda d: d["index"])]


if __name__ == "__main__":
    vecs = embed_texts(["the quick brown fox", "jumps over the lazy dog"])
    print("vectors:", len(vecs), "| dims:", len(vecs[0]))
