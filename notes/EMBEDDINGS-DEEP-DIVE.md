# Embeddings — Deep Dive

**Course:** ShopIQ Mentor Program — Day 2 core
**Goal:** Understand embeddings at three levels — *what* they are, *how* an embedding model produces them, and *how we use them* in ShopIQ including every tradeoff we made.

---

## 1. The Problem Embeddings Solve

Keyword search matches **literal words**. It fails on **meaning**.

| Search method | "Can I return opened electronics?" |
|---|---|
| SQL `LIKE '%return%'` | Finds docs containing the word "return" |
| Semantic (embedding) | Finds the doc that **means** the same thing, even if it says *"Opened items of an electronic nature cannot be exchanged or refunded"* — **zero shared words** |

Embeddings convert "meaning" into **geometry**: texts that mean similar things land at nearby points in a high-dimensional space. Search becomes *find points near my query point*.

---

## 2. What an Embedding Actually Is

An **embedding** is a vector: an ordered list of real numbers, e.g.

```
[0.043, 0.000, 0.020, -0.019, ...]   # 2048 numbers for our model
```

- **Fixed length** per model. Ours: **2048 dimensions**. text-embedding-3-small: 1536. all-MiniLM-L6-v2: 384.
- **Not human-interpretable.** The dimensions are a coordinate system the model invented during training. You can't read meaning from a single number; you trust that *nearby = similar*.
- **Direction carries meaning, magnitude is usually noise** — this is why cosine similarity (angle) is the standard metric for text.

---

## 3. How an Embedding Model Produces a Vector (the mechanism)

An embedding model is an **encoder-style transformer**. When you give it text, it does roughly:

1. **Tokenize** — split the text into tokens (same tokenizer concept from Day 1, but no *generation* happens).
2. **Pass through the transformer stack** — each token becomes a contextual vector; every token's representation is refined using all the other tokens (attention). The output of the final layer is a vector **per token**.
3. **Pool** — collapse the per-token vectors into ONE vector for the whole text. Common choices:
   - **Mean pooling**: average all token vectors. (Standard for sentence embeddings.)
   - CLS pooling: take a special `[CLS]` token's vector.
4. **Normalize** — scale to unit length (L2-normalize). This makes the vector's *length* 1, so cosine similarity and Euclidean distance rank identically, and dot product becomes equivalent to cosine similarity.

**Key mental model:** the model is trained (contrastive learning) so that similar-meaning texts get similar vectors. "Similar" was learned from massive text corpora — the model knows that "refund" and "return" co-occur with similar contexts, so their vectors end up close.

**Embedding models vs. chat models:** a chat model *generates* the next token; an embedding model *compresses* a whole input into one fixed-size vector and outputs no text at all. Different architectures, different endpoints.

---

## 4. Hosted vs. Local Embeddings — Our Decision and Tradeoffs

This was a live decision forced by two facts: OpenRouter's `/models` catalog showed no embedders, and your connection is metered. You found that the **`/embeddings` endpoint** works even though the catalog doesn't list embedders. We weighed:

| | **Hosted (chosen)** | Local (sentence-transformers) |
|---|---|---|
| Download size | ~0 (tiny JSON calls) | **~4–5 GB (PyTorch)** |
| Cost | Free tier | Free |
| Setup | API key only | Heavy pip install + model download |
| Rate limits | Yes (20 req/min free tier) → batch | None |
| Determinism | Depends on provider availability | Fully local/offline |
| Failure mode | Provider hiccup → retry | None once installed |

**Why we chose hosted:** zero download (you have 3 GB), no heavy dependency, and OpenRouter's embeddings are genuinely free. **The cost is provider reliance** — which we mitigate by batching (fewer requests) and by isolating all embedding calls in one module (`embeddings.py`) so we could swap providers without touching the rest of the code.

**The design-doc note:** the original DD said "small hosted embedding model." We honored that intent; we just discovered OpenRouter's embeddings live at a different endpoint than its model catalog implies.

---

## 5. The OpenRouter `/embeddings` Endpoint — Wire Format

Request (what our code sends):
```json
POST https://openrouter.ai/api/v1/embeddings
Authorization: Bearer sk-or-...
Content-Type: application/json

{
  "model": "nvidia/llama-nemotron-embed-vl-1b-v2:free",
  "input": ["text one", "text two", "..."],
  "encoding_format": "float"
}
```

Response:
```json
{
  "object": "list",
  "data": [
    { "embedding": [0.043, ...], "index": 0 },
    { "embedding": [0.021, ...], "index": 1 }
  ],
  "usage": { "prompt_tokens": 11, "total_tokens": 11, "cost": 0 }
}
```

Key facts from our live test:
- `input` accepts an **array** — one call can embed many texts. This is the batching lever.
- `data` entries have an `index` so you can match results to inputs.
- `usage.cost: 0` — genuinely free tier.
- **`encoding_format: "float"`** — returns raw floats (the only sensible format for DB storage; the alternative `base64` is for transport efficiency).

---

## 6. Batching — The Free-Tier Survival Skill

Free-tier endpoints impose **rate limits** (e.g. 20 requests/min). If you embed one chunk per request, 100 chunks = 100 requests = guaranteed throttling. Batch instead:

```python
for i in range(0, len(contents), 20):
    batch = contents[i:i+20]      # 20 chunks at a time
    vectors = embed_texts(batch)  # ONE API request for 20 texts
```

**20 requests become 1.** Fewer round-trips, fewer rate-limit errors, faster. In production you'd also add retry-with-backoff on 429 responses.

---

## 7. The Dimension Question — and the HNSW 2000 Cap (our key tradeoff)

**Dimension** = the length of the vector. It must match your column type exactly: `vector(2048)` column ↔ 2048-dim model. If they differ, queries break.

Then the tradeoff that bit us:

| Embedder | Dims | HNSW index possible? | Cost |
|---|---|---|---|
| `nvidia/llama-nemotron-embed-vl-1b-v2:free` | **2048** | **No** (pgvector HNSW caps at 2000) | Free |
| `text-embedding-3-small` | 1536 | Yes | Paid (~$0.02/M tokens) |

**What happened:** we created the HNSW index and Postgres rejected it: *"column cannot have more than 2000 dimensions for hnsw index."* pgvector's HNSW **and** IVFFlat indexes both cap at **2000 dims** — an internal storage limitation. The vector *column* stores 2048 fine; only the *index* refuses.

**Our decision:** keep the **free 2048-dim** model and drop the index, using **exact (brute-force) nearest-neighbor search**.

**Why that's not a cop-out:**
- Exact search scans all rows computing cosine distance — at **a few thousand chunks** that's sub-millisecond to low-millisecond. We measured it: instant.
- Indexes matter when you have **millions** of vectors (or need low-latency at scale). We don't.
- It's a **documented, reversible** tradeoff: if the corpus grows, switch the embedder to a ≤2000-dim model (`text-embedding-3-small`, 1536 dims) and `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` — no code change elsewhere, because all embedding calls go through one module.

**Interview line:** "Our free embedder outputs 2048 dims, which exceeds pgvector's 2000-dim HNSW cap, so we use exact search — fast at our corpus size. Scaling up is a config change, not a rewrite."

---

## 8. Similarity Metrics — Which Distance and Why

| Metric | pgvector op | Formula intuition | When |
|---|---|---|---|
| **Cosine distance** | `<=>` | 1 − cos(angle) | **Text/RAG (our choice)** — ignores magnitude, measures direction |
| Euclidean (L2) | `<->` | straight-line distance | Magnitude matters (e.g. embeddings not normalized) |
| Dot product | `<#>` | ‖a‖‖b‖cos(θ) | Fast when vectors are normalized; then = cosine |

Because embedding models output **normalized** vectors (unit length), all three rank results identically. We use **cosine** (`<=>`) because it's the semantic-search convention and stays correct even if a batch comes back unnormalized.

**The rule that makes distance meaningful:** stored chunks and queries must be embedded by the **same model**. Coordinates from model A and model B live in different spaces; distance between them is meaningless garbage. (Classic production bug: re-indexing with a new model but old vectors.)

---

## 9. The Grounding Threshold — Turning Distance into an Answer Policy

Distances from our live run:

| Query | Top hit distance | Next | Far ones |
|---|---|---|---|
| "can customers return opened electronics?" | **0.354** | 0.628 | 0.75+ |
| "my charger stopped working, do I have any recourse?" | **0.80** | 0.81 | 0.87 |

The gap between "clearly relevant" (0.35) and "weak/irrelevant" (0.80+) is the signal. A **threshold** separates them: if the best match's distance is above it, the system says **"No relevant policy found"** instead of answering. That single check is what makes answers genuinely **grounded** — the model is forbidden from answering from its own knowledge when the corpus has nothing to offer.

---

## 10. Code Walkthrough — `backend/embeddings.py` (every line)

```python
def embed_texts(texts: list[str], model: str = EMBED_MODEL) -> list[list[float]]:
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
    return [d["embedding"] for d in sorted(data, key=lambda d: d["index"])]
```
- `requests.post(url, headers, json=...)` — HTTP POST; `json=` auto-serializes the dict.
- **Auth** from the environment at call time (never printed, never committed).
- `timeout=60` — don't hang forever.
- `resp.raise_for_status()` — any HTTP error raises loudly.
- Return: vectors sorted by their `index`, so output order always matches input order.

`EMBED_MODEL` and `BASE_URL` come from `.env` via `os.getenv` — **the model is config, not a hardcoded string.** That's what makes swapping embedders a one-line change.

---

## 11. "This is what you say in the interview"

- "Embeddings turn text into fixed-size vectors so similarity is geometry. I store policy chunks as 2048-dim vectors in a pgvector column, embed queries with the *same* model, and rank by cosine distance."
- "I chose a hosted free embedder over a local one to avoid a multi-GB PyTorch install and keep the demo dependency-light; I batch texts per request to respect free-tier rate limits."
- "Our embedder outputs 2048 dims, past pgvector's 2000-dim HNSW cap, so I use exact search — sub-millisecond at a few thousand chunks — and documented the switch to a 1536-dim model as the scale-up path."
- "A distance threshold is the grounding check: above it, we refuse to answer rather than hallucinate."
- "One module owns all embedding calls, so the provider/model is a config value — swap it without touching the pipeline."

---

## 12. Pitfalls Checklist

1. **Column dim ≠ model dim** → query errors. Match them (`vector(2048)` ↔ 2048).
2. **Indexing >2000 dims** → Postgres error. Use exact search or a ≤2000-dim model.
3. **Embedding queries with a different model** → meaningless distances.
4. **One request per text** → rate-limit throttling. Batch.
5. **No timeout / no `raise_for_status`** → silent hangs and silent failures.
6. **Hardcoded model** → changing provider means editing code. Make it config.

---

## 13. Practice Questions

1. Why does cosine similarity (not word overlap) find "charger stopped working" matches a policy that never says "charger"?
2. What does "normalized to unit length" buy us? Why does it make cosine, dot, and Euclidean equivalent in ranking?
3. If we switched the embedder to text-embedding-3-small, list every code/config change required (answer: EMBEDDING_MODEL + EMBEDDING_DIM + optionally re-index + re-embed existing chunks).
4. Why must re-embedding old chunks happen if we switch models? (Hint: consistency rule.)
5. What happens to `ORDER BY embedding <=> :q LIMIT k` when the table grows to 5M rows, and what's the fix?
6. Why do we sort by `index` before returning vectors from `embed_texts`?
