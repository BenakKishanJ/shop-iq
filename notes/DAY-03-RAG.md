# Day 3 — RAG End-to-End (Deep Dive)

Retrieval (Day 2) meets generation: a question becomes a grounded, *cited*
answer — or an honest refusal. This note walks the two files line by line,
explains the thinking behind every constant and prompt rule, and records the
failures we fixed so you can rebuild it from memory.

**Files:** `backend/llm.py`, `backend/rag_answer.py`
**Depends on:** Day 2's `backend/search_policies.py` (retrieval)

---

## 1. The full RAG loop (the mental model)

```
question
  │
  ├─ 1. EMBED        embed_texts([question]) — SAME model that made the chunks
  ├─ 2. RETRIEVE     ORDER BY embedding <=> :vec LIMIT k   (Day 2 machine)
  ├─ 3. GROUND CHECK if top_distance > threshold  →  REFUSE (no LLM call)
  │                     else  →  continue
  ├─ 4. ASSEMBLE     pack chunks into the prompt as numbered "sources"
  ├─ 5. GENERATE     LLM (temperature 0.2) answers ONLY from those chunks
  └─ 6. CITE         every claim ends with  [doc title :: section]
```

Steps 1–2 were Day 2. Step 3 is the *new* safety mechanism. Steps 4–6 are the
"augmented generation". Together: **R**etrieval-**A**ugmented **G**eneration.

---

## 2. The three pillars (understand these cold)

### 2.1 Context window is the whole trick
The LLM is a probability engine (Day 1) — it predicts the next token. It has
**zero** knowledge of ShopIQ's policies. So we *paste the retrieved chunks into
the prompt* and instruct it to answer from them alone. This is **in-context
learning**: steering behavior through prompt content, no retraining. If you
removed the chunks, the model would invent policies — that's hallucination.

### 2.2 Grounding = two layers of control
- **Deterministic, pre-LLM:** `DISTANCE_THRESHOLD`. If the best chunk is too far
  away, we never call the LLM at all — we refuse. This is a *hard guarantee*:
  an out-of-scope question cannot produce a fabricated answer, because the
  generator is never even reached.
- **Probabilistic, post-LLM:** the system prompt. "Answer ONLY from the sources,
  cite every claim, say 'not covered' if unsure." This keeps *in-scope* answers
  faithful to the evidence.

Layer 1 prevents the worst failure mode; layer 2 makes good answers great.
Both are cheap. Both are how you tell the interview story "I built guards
against hallucination."

### 2.3 Citations make answers verifiable
Forcing `[doc title :: section]` after each claim means every fact traces to a
chunk. A user (or reviewer) can click through to the source. This is the PRD's
core requirement and the interview's favourite probe: *"how do I know the bot
isn't making it up?"* → "because every claim must carry a citation, and the
answer is built only from retrieved chunks."

---

## 3. Code walkthrough — `backend/llm.py`

The LLM client. One function a Day-5 tool-call loop will reuse. Read it as:
"turn a conversation into text, and survive the free-tier rate limits."

### Imports & config (lines 8–18)
```python
import os, time, requests
from dotenv import load_dotenv
load_dotenv()
CHAT_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-oss-20b:free")
BASE_URL   = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
MAX_RETRIES = 3
RETRY_BACKOFF = 2.0   # seconds, doubles each attempt
```
- **`load_dotenv()`** loads `./.env` (the real API key) without committing it.
  The key lives in the environment, never in code.
- **Config from env with a fallback default** — the model name is a config
  value, not a hard-coded string. Swap models by editing `.env`, not code.
- `MAX_RETRIES`/`RETRY_BACKOFF` are the rate-limit safety net.

### `_post()` (lines 21–42) — the retry engine
```python
for attempt in range(MAX_RETRIES):
    resp = requests.post(url, headers={...}, json=payload, timeout=90)
    if resp.status_code == 200: return resp.json()
    if resp.status_code in (429, 500, 502, 503):
        last_error = resp.status_code
        time.sleep(RETRY_BACKOFF * (2 ** attempt))   # 2s → 4s → 8s
        continue
    resp.raise_for_status()
raise RuntimeError(...)
```
- **`timeout=90`** — never let the client hang forever on a slow model.
- **`429` (rate limit) + `5xx` (server busy) are transient** → sleep and retry,
  doubling the wait each attempt (exponential backoff). The free OpenRouter
  tier throttles bursts; this absorbs the reality we hit live.
- **Anything else is not transient** → `raise_for_status()` fails loud. Never
  swallow a real bug behind a retry loop.
- After all retries fail → `RuntimeError` with the last status, so callers know
  *why*.

### `complete()` (lines 45–54)
```python
def complete(messages, model=CHAT_MODEL, temperature=0.2, max_tokens=1024) -> str:
    data = _post({"model": model, "messages": messages,
                  "temperature": temperature, "max_tokens": max_tokens})
    return data["choices"][0]["message"]["content"]
```
- Takes a list of `{role, content}` dicts (system/user/assistant) and returns
  the reply **text**. That's the entire interface — Day 5 extends it by adding
  `tools` and reading `tool_calls` from the same shape.
- **`temperature=0.2`** — low, deterministic. Format adherence (citations,
  later: tool calls) matters more than creativity. High temperature would
  produce prettier but sloppier, un-citable prose.

---

## 4. Code walkthrough — `backend/rag_answer.py`

The RAG loop itself. Imports Day 2's `search()` and our new `complete()`.

### Config & the system prompt (lines 16–32)
```python
DISTANCE_THRESHOLD = 0.80
TOP_K = 4
```
- `TOP_K = 4` — how many chunks we feed the model. Enough evidence, not so many
  the window fills with noise. (Tune per corpus; more chunks ≠ better.)
- `DISTANCE_THRESHOLD = 0.80` — see §6 for how we tuned it.

The system prompt, rule by rule:

| Rule | Why |
|---|---|
| "answer using ONLY the sources provided" | forbids the model's own knowledge |
| "Base every factual claim on the provided sources" | each sentence must be evidence-backed |
| "cite using ONLY `[doc title :: section]`" | fixed, parseable citation format |
| "copied VERBATIM from the Source line" | prevents paraphrased/invented citations |
| "Never cite the bracketed source number like `[1]`" | the bug we fixed — see §7 |
| "If the sources do not contain the answer, say exactly 'This is not covered by the available store policies.'" | a second refusal path for in-threshold-but-unanswered cases |
| "Never use your own knowledge. Never invent policies, numbers, or procedures." | belt-and-braces anti-hallucination |

### `build_context()` (lines 35–40)
```python
for i, hit in enumerate(hits, start=1):
    lines.append(f"[{i}] Source: {hit['title']} :: {hit['section']}\n{hit['content']}")
return "\n\n".join(lines)
```
- Numbers chunks `[1]…[k]` so the model can refer to them — but the *citation*
  must use the full title/section, not the number (see §7).
- The `Source:` prefix is what the prompt's "copy VERBATIM" rule points at.

### `answer()` (lines 43–75) — the heart
```python
hits = search(question, k=k)
top_distance = hits[0]["distance"] if hits else float("inf")
if top_distance > threshold:
    return { "grounded": False,
             "answer": "No relevant policy found. I can't answer that ...",
             "sources": hits, "top_distance": round(top_distance, 4) }
# else:
context = build_context(hits)
messages = [
  {"role": "system", "content": SYSTEM_PROMPT},
  {"role": "user",   "content": f"Question: {question}\n\nAvailable sources:\n{context}\n\nAnswer ..."},
]
reply = complete(messages, temperature=0.2)
return { "grounded": True, "answer": reply, "sources": hits,
         "top_distance": round(top_distance, 4) }
```
- **Empty hits → `float("inf")`** → always trips the threshold → graceful
  refusal instead of an index error on `hits[0]`.
- **The refusal returns *before* any LLM call** — the cheap, deterministic
  safety gate.
- **The return is a plain dict** — `question`, `grounded`, `answer`, `sources`,
  `top_distance`. Day 5's `/api/chat` serializes this dict to JSON directly.
  Keeping this a *pure function* (question → dict) is what makes it testable and
  frontend-ready.

### `__main__` (lines 78–87)
CLI so we can demo from the terminal: `python rag_answer.py "question?"`.
Prints the question, grounding verdict, top distance, the answer, and the
sources actually used (first two).

---

## 5. The prompt as actually sent (memorize this shape)

```
system: You are ShopIQ, a grounded retail policy assistant.
        You answer questions using ONLY the sources provided in the user message.
        Rules: ...

user:   Question: can customers return opened electronics?

        Available sources:
        [1] Source: Returns and Refunds Policy :: Opened Electronics
        Returns and Refunds Policy — Opened Electronics:
        Opened items of an electronic nature cannot be exchanged or refunded
        once the packaging seal has been broken, unless the item is found to
        be defective. ...

        [2] Source: Returns and Refunds Policy :: Returns Window
        ...

        Answer the question using ONLY the sources above, with citations.
```

This is **context assembly** in action: raw chunks → labelled, numbered sources.

---

## 6. Tuning the grounding threshold (evidence, not vibes)

Live distances we measured (2048-dim nemotron embeddings):

| Query | top distance | verdict |
|---|---|---|
| "do we pay a deposit on large supplier orders?" | 0.34 | strong match |
| "can customers return opened electronics?" | 0.35 | strong match |
| "who is allowed to see customer purchase histories?" | 0.37 | strong match |
| "do staff get a discount on purchases?" | 0.40 | good match |
| "how long do customers have to return an item?" | 0.43 | good match |
| "what is the best temperature to brew green tea?" | 0.94 | correctly refused |

`0.80` sits cleanly in the gap between "good match ~0.4" and "irrelevant ~0.9".
The recipe: label ~10–20 queries as in/out of scope, measure their top distance,
and pick a threshold in the gap. **Never copy a threshold across embedding
models** — cosine distances are model-specific.

---

## 7. Failure modes we hit live (and the fixes)

| Failure | Symptom | Fix |
|---|---|---|
| **Model cited source numbers** | `[1 :: Opened Electronics]` instead of `[Returns and Refunds Policy :: Opened Electronics]` | Rewrote the citation rule to demand the full `[doc title :: section]` copied verbatim, and explicitly banned `[1]`. |
| **429 rate limit** | `HTTPError: 429` mid-demo, because 5 requests fired back-to-back | `llm._post()` retries 429/5xx with `2s→4s→8s` backoff; non-transient errors still fail loud. |

Lesson: prompt engineering is **iterate → observe → tighten**. The model told
us its misunderstanding through its output; we gave it a precise rule and it
complied on the next try.

---

## 8. Verified results (reproduce with the commands below)

```
$ python rag_answer.py "can customers return opened electronics?"
grounded: True | top distance: 0.35
A: Customers cannot return opened electronics unless the item is found to be
   defective. [Returns and Refunds Policy :: Opened Electronics]

$ python rag_answer.py "what is the best temperature to brew green tea?"
grounded: False | top distance: 0.94
A: No relevant policy found. I can't answer that from the store's documents,
   and I won't guess.
```

Five in-scope questions across four different documents (Returns, Pricing,
Privacy, Supplier Terms) all retrieved the *correct* document — proving the
retrieval generalizes, not just for the one test query.

---

## 9. How Day 5 plugs in

`answer()` is a pure function returning a JSON-serializable dict. Day 5:
1. Wraps it in a FastAPI route `POST /api/chat` that takes `{question}`.
2. Streams the reply to a Next.js chat UI.
3. Parses `[doc title :: section]` citations from `answer` into clickable chips.
4. Extends `llm.complete()` to *call tools* (the same messages + `tool_calls`
   field), making the agent able to answer "do we have stock of X?" by calling
   the Day 4 MCP tools.

---

## 10. Interview Q&A

1. **What is RAG and why use it?** Retrieval-augmented generation: retrieve
   relevant evidence, inject it into the prompt, generate a grounded answer.
   Use it to ground LLMs in private/current data without retraining, and to cut
   hallucination.
2. **How does grounding work here?** Two layers — a deterministic pre-LLM
   distance threshold (refuse if no chunk is close), and a probabilistic
   post-LLM system prompt (answer only from sources, cite everything).
3. **Why 0.8 as the threshold?** Measured distances: good matches ~0.34–0.43,
   irrelevant ~0.94. 0.8 sits in the gap. Re-tuned per embedding model.
4. **Why low temperature?** Deterministic output for format adherence
   (citations). Same reason Day 5 uses low temperature for tool calls.
5. **What did you learn from a failure?** The model first cited source numbers
   (`[1]`); we rewrote the prompt to demand verbatim `[doc title :: section]`.
   Also hit 429 rate limits; added exponential-backoff retries.
