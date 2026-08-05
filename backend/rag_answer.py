"""RAG answer: retrieve -> grounding check -> generate a cited answer.

The full grounding story:
1. retrieve the top-k chunks (Day 2 machinery)
2. if the best match is too far away -> refuse (no LLM call at all)
3. otherwise pack the chunks into the prompt and ask the model to
   answer ONLY from them, citing [doc title :: section]

Usage:
    python rag_answer.py "can customers return opened electronics?"
"""
import sys
from search_policies import search
from llm import complete

# Tuned from live distances: strong matches ~0.35, weak/irrelevant 0.80+.
# Configurable so it can be adjusted per embedding model.
DISTANCE_THRESHOLD = 0.80
TOP_K = 4

SYSTEM_PROMPT = """You are ShopIQ, a grounded retail policy assistant.
You answer questions using ONLY the sources provided in the user message.
Rules:
- Base every factual claim on the provided sources.
- After each claim, cite the source using ONLY this exact format:
  [doc title :: section]
  where "doc title" and "section" are copied VERBATIM from the Source line
  of the source you used. Never cite the bracketed source number like [1]
  or [2] — always use the full "[doc title :: section]" form.
- If the sources do not contain the answer, say exactly:
  "This is not covered by the available store policies." and do not guess.
- Never use your own knowledge. Never invent policies, numbers, or procedures."""


def build_context(hits: list[dict]) -> str:
    """Turn retrieved chunks into a numbered, citable context block."""
    lines = []
    for i, hit in enumerate(hits, start=1):
        lines.append(f"[{i}] Source: {hit['title']} :: {hit['section']}\n{hit['content']}")
    return "\n\n".join(lines)


def answer(question: str, k: int = TOP_K,
           threshold: float = DISTANCE_THRESHOLD) -> dict:
    """Return a grounded, cited answer (or an honest refusal)."""
    hits = search(question, k=k)
    top_distance = hits[0]["distance"] if hits else float("inf")

    if top_distance > threshold:
        return {
            "question": question,
            "grounded": False,
            "answer": "No relevant policy found. I can't answer that from the "
                      "store's documents, and I won't guess.",
            "sources": hits,
            "top_distance": round(top_distance, 4),
        }

    context = build_context(hits)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": (
            f"Question: {question}\n\n"
            f"Available sources:\n{context}\n\n"
            f"Answer the question using ONLY the sources above, with citations.")},
    ]
    reply = complete(messages, temperature=0.2)

    return {
        "question": question,
        "grounded": True,
        "answer": reply,
        "sources": hits,
        "top_distance": round(top_distance, 4),
    }


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "can customers return opened electronics?"
    result = answer(q)
    print(f"Q: {q}")
    print(f"grounded: {result['grounded']} | top distance: {result['top_distance']}")
    print(f"\nA: {result['answer']}")
    if result["grounded"]:
        print("\nsources used:")
        for s in result["sources"][:2]:
            print(f"  - {s['title']} :: {s['section']}  (dist {s['distance']})")
