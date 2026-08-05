# Vector Databases & pgvector — Complete Reference

**Course:** ShopIQ Mentor Program — Day 1 (Environment lead-in) / Day 2 (application)
**Audience:** Engineer with SQL but zero vector-DB background
**Goal:** Understand what embeddings and similarity search are, and how to run them in Postgres with pgvector — the foundation of RAG.

---

## 1. The Problem That Vector Search Solves

Keyword search (`LIKE`, full-text) matches **literal words**. It fails on **meaning**:

> You ask: *"Can you return opened electronics?"*
> The document says: *"Opened items of an electronic nature cannot be exchanged or refunded."*

The document *answers* the question but shares almost no words with it. A vector search finds it because it matches on **what the text means**, not what it says.

---

## 2. The Core Idea: Text → Coordinates

An **embedding model** converts a piece of text into a **vector** — an ordered list of numbers (e.g., 768 real numbers). It's trained so that:

- Texts with **similar meaning** end up at **nearby points** in space.
- Texts with **unrelated meaning** end up **far apart**.

**"Meaning" becomes geometry.** Search becomes "find points near my query point."

Two things to internalize:

1. **The dimensions are not interpretable** — they're a learned coordinate system. Don't try to read meaning from individual numbers; trust that *proximity = similarity*.
2. **Similarity is approximate by nature.** Search returns what is *geometrically nearest*, which is usually (not always) what you meant. (In our demo, point B ranked above the "intended" point A because B happened to be closer to the query — the DB doesn't know intent.)

---

## 3. Measuring Similarity

For normalized vectors (embedding models output unit-length vectors by default), these rank results identically:

| Operation | pgvector operator | What it measures | Use case |
|---|---|---|---|
| **Cosine distance** | `<=>` | The *angle* between vectors | **Text/RAG (our choice)** — magnitude is noise, direction = meaning |
| **Euclidean / L2 distance** | `<->` | Straight-line distance | Magnitude matters (some recommendations) |
| **Dot product distance** | `<#>` | Product of magnitudes × cosine | Speed in narrow cases |

**The rule you'll use constantly: `ORDER BY embedding <=> :query_vec ASC LIMIT k` — smallest distance first, take the top k.**

---

## 4. pgvector in Postgres

pgvector is an **extension** that adds a `vector(n)` column type plus the distance operators above, into the Postgres you already have. No separate database service — this is the "one datastore, no sprawl" choice from the design doc.

## 4.1 Enable it
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```
(Our image `pgvector/pgvector:pg16` ships with it preloaded, but enabling is still explicit and idempotent.)

## 4.2 A column
```sql
CREATE TABLE doc_chunks (
  chunk_id  SERIAL PRIMARY KEY,
  doc_title TEXT,
  content   TEXT,
  embedding vector(768)      -- 768 matches the embedding model we'll use
);
```

## 4.3 Insert
```sql
INSERT INTO doc_chunks (doc_title, content, embedding)
VALUES ('returns', 'Opened electronics cannot be refunded', '[0.1, 0.9, ...]');
```
The vector literal is a single-quoted string of comma-separated numbers: `'[0.1, 0.9, 0.5]'`.

## 4.4 Query by similarity
```sql
SELECT doc_title, content, embedding <=> :query_embedding AS dist
FROM doc_chunks
ORDER BY embedding <=> :query_embedding
LIMIT k;                     -- top k nearest = most similar
```

## 4.5 The threshold / grounding check
RAG depends on **not answering when nothing is relevant**:
```sql
-- if the MINIMUM distance is too large, there's no relevant document
SELECT MIN(embedding <=> :query) FROM doc_chunks HAVING MIN(...) < :threshold;
```
If the nearest chunk is farther than a tuned threshold → answer **"No relevant document found"** instead of letting the model guess. This is what makes retrieval genuinely "grounded."

---

## 5. Indexes: Making It Fast

Brute-force distance over thousands of rows works but is O(N). Two index types ship with pgvector:

| Index | Type | Notes |
|---|---|---|
| **HNSW** | Graph-based (hierarchical navigable small world) | **Modern default.** Excellent quality/speed tradeoff, incremental inserts, more memory. |
| **IVFFlat** | Cluster/quantization-based | Older; needs data present before building; slightly less accurate. |

Build one **after** some data exists (HNSW is more forgiving): 
```sql
CREATE INDEX idx_chunks_hnsw ON doc_chunks USING hnsw (embedding vector_cosine_ops);
```
- `vector_cosine_ops` = the *operator class* matching the `<=>` cosine operator. Use `vector_l2_ops` for `<->`, `vector_ip_ops` for `<#>`.
- The index is used **automatically** when the planner decides it's worth it. On a 3-row table Postgres will ignore it (Seq Scan) — that's correct, not a bug. The index shines at thousands+ rows.

---

## 6. Our Day-1 Demo (recreate it yourself)

```sql
-- in the shopiq_learn database
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE demo_chunks (chunk_id SERIAL PRIMARY KEY, label TEXT, embedding vector(3));
INSERT INTO demo_chunks (label, embedding) VALUES
  ('A', '[1.0, 0.0, 0.0]'),
  ('B', '[0.9, 0.2, 0.1]'),
  ('C', '[-1.0, -0.8, 0.5]');

SELECT label, ROUND((embedding <=> '[0.95, 0.1, 0.1]')::numeric, 4) AS cosine_dist
FROM demo_chunks ORDER BY embedding <=> '[0.95, 0.1, 0.1]';
-- Result order: B (0.0064), A (0.0109), C (1.7422)  → C is clearly irrelevant
```

**Takeaway:** the handful-of-`0.01`-vs-`1.74` gap between "relevant" and "irrelevant" IS the signal we exploit. In real RAG, that gap (and a threshold through it) is what separates a grounded answer from a hallucination.

---

## 7. How This Becomes Real RAG (bridge to Day 2/3)

In this demo we **typed** vectors by hand. In ShopIQ we don't:

1. **Embed** — run real policy text through an embedding model to get real 768-dim vectors (Day 2).
2. **Store** — put them in `DocumentChunks.embedding` (exactly the `demo_chunks` table shape).
3. **Query** — embed the user's question, nearest-neighbor search, apply threshold (Day 3).
4. **Ground** — hand the top chunk(s) to the LLM as context and force citations (Day 3).

The vector column, operators, index, and threshold — everything you just learned — sit underneath that whole flow.

---

## 8. Practice Drills

1. In `shopiq_learn`, build `demo_chunks` from scratch and reproduce the ranking above.
2. Switch the query to `<->` (Euclidean) and note how the distances differ while the *rank order* here stays the same (both normalized).
3. Add a row `D ... = '[0.95, 0.12, 0.08]'` and confirm it now becomes the nearest neighbor — watch the ranking change on a real edit.
4. Write a query that returns only documents within a distance threshold of `0.1`, and explain in one sentence why that's the "grounding check."
5. Drop and recreate the HNSW index; run `EXPLAIN ANALYZE` and note whether the planner uses it (it won't on a tiny table).