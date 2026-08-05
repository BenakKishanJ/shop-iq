"""Policy search: embed a question, find nearest chunks in pgvector.

Demonstrates the retrieval half of RAG:
    question -> embed -> ORDER BY embedding <=> :query LIMIT k

Usage:
    python search_policies.py "can customers return opened electronics?" [k]
"""
import sys
from db import get_conn
from embeddings import embed_texts


def search(query: str, k: int = 5) -> list[dict]:
    query_vec = embed_texts([query])[0]
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT p.title, c.section_label, c.content,
                          (c.embedding <=> %s::vector) AS dist
                   FROM document_chunks c
                   JOIN policy_documents p USING (doc_id)
                   ORDER BY c.embedding <=> %s::vector
                   LIMIT %s""",
                (query_vec, query_vec, k),
            )
            return [
                {"title": r[0], "section": r[1], "content": r[2],
                 "distance": round(r[3], 4)}
                for r in cur.fetchall()
            ]
    finally:
        conn.close()


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "can customers return opened electronics?"
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    print(f"query: {q!r}\n")
    for hit in search(q, k):
        print(f"  [dist {hit['distance']}] {hit['title']} :: {hit['section']}")
        print(f"      {hit['content'][:110]}...")
