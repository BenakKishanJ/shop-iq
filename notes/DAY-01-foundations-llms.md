# Day 1 — LLM Foundations: What an LLM Is, and Why Every Tool We Use Exists to Fix It

**Course:** ShopIQ Mentor Program — Day 1
**Goal:** Understand the LLM at a level where you can *explain* every architectural choice in ShopIQ as a response to an LLM's nature — not as a list of buzzwords you memorized.
**North star for the whole week:**
> **An LLM is not a database. It does not know facts. It predicts the next token.**

If you can explain the *three weaknesses* that follow from that sentence, and map each ShopIQ component to the weakness it fixes, you will out-talk most candidates.

---

## 1. The Foundation: What an LLM Actually Does

### 1.1 It predicts text, one chunk at a time

An LLM (Large Language Model) reads and writes in **tokens** — small chunks of text (~3–4 characters each; sometimes a whole word, sometimes part of one). "ShopIQ" might tokenize as `["Shop", "I", "Q"]` or `["Shop", "IQ"]`. Models have a fixed **vocabulary** of tokens (e.g., 128,000).

When you send it text, the model computes a **probability distribution across its whole vocabulary** for *"what token is most likely to come next?"* — then samples one token. It appends that token, and predicts again. And again.

```
input tokens → [model computes probabilities] → sample next token → append → repeat
```

This is called **autoregressive generation**. There is no "thinking" beyond predicting the next token, over and over. Every piece of text the model ever produces — a poem, a lie, a JSON tool call — is built token-by-token from these probabilities.

### 1.2 Consequences that change everything

Because the model was trained to predict *plausible* text, it optimizes for **plausibility, not truth**. From that single fact, three weaknesses follow — and **this whole project is a response to them**:

| # | Weakness | What it means | What fixes it in ShopIQ |
|---|---|---|---|
| 1 | **Hallucination** | It can be confident and wrong. It "knows" nothing; it produces text that *sounds* like knowledge. | **RAG** (ground answers in real documents + citations + grounding threshold) |
| 2 | **No real-time / private data** | It only knows patterns from its training data. It has no idea what's in *your* store's database. | **MCP tools** (`check_stock`, `sales_trend`) fetch live data mid-conversation |
| 3 | **Cannot take actions** | It only emits text. It cannot write to a DB or send a Telegram message. | **Tool calls + guardrails** (`flag_reorder`, ActionLog, human approval) |

Hold onto this table. It's the skeleton of your interview story.

---

## 2. The Four Core Concepts, Properly

### 2.1 Tokens — the unit of everything

- The model reads/writes tokens, not characters or words.
- **Cost** is measured in tokens (`$/1M input tokens`, `$/1M output tokens`).
- **Context limits** are measured in tokens (a "131K context" model sees 131,000 tokens max).
- When you build a system prompt, chat history, or tool result — every byte of it is tokenized before the model sees it.

**Practical takeaway:** you'll see token counts in every OpenRouter response. They're not an implementation detail — they're *the* pricing and capacity unit. When we prompt-engineer on Day 5, we're literally budgeting tokens.

### 2.2 Next-token prediction — the mechanism

There's no hidden engine. The loop above *is* the model. Two implications:

- **"Reasoning" is sequential** — the model can't "rethink" earlier tokens; it's committed once emitted.
- **Reproducibility is a knob, not a guarantee** — the same prompt can give different answers, because sampling is random by default.

### 2.3 Temperature — the randomness knob

Every prediction is a probability distribution. Temperature controls how literally we sample it:

- **Low (0–0.3):** almost always pick the most probable token → deterministic, precise, rule-following. **This is what we use for tool calls** — we *need* the model to reliably emit `{"name":"check_stock","arguments":{...}}`, not get creative.
- **High (0.7–1.5):** sometimes pick less-likely tokens → varied, creative. Good for brainstorming, terrible for structured output.

**Interview line:** "For any task where the model must produce machine-readable output — tool calls, JSON — I keep temperature low, because I'm optimizing for the model following a format, not for creativity."

### 2.4 Context window — "memory" is fake

The model sees a fixed window of tokens per request. **It has no memory between requests.** Every AI app's "memory" is really just *pasting the previous conversation back into the context window* on the next request.

This single insight makes agents legible:

> When an agent "calls a tool," the tool's result is just **text appended to the context window** and sent back to the model. No magic. A database row, a stock count, a Telegram response — all reduced to text the model reads and then predicts from.

That's why the agent loop works: the model looks at `[system + user + tool_result]` and predicts the next move.

---

## 3. The Interface: Chat Completions

We talk to LLMs (via OpenRouter) through the **chat completions** API. Every request is:

```json
{
  "model": "some/model:id",
  "messages": [
    {"role": "system",    "content": "You are ShopIQ, a grounded retail assistant. Cite sources."},
    {"role": "user",      "content": "How much stock do we have of SKU-101?"}
  ],
  "temperature": 0.2
}
```

### The four roles (learn these cold)

| Role | Purpose | In ShopIQ |
|---|---|---|
| `system` | Instructions that set behavior for the whole conversation | Our system prompt: "always cite sources, state reasoning before flag_reorder, never flag twice per cycle" |
| `user` | What the human (or the scheduled review job) says | Chat messages; also the review job's "review all products…" instruction |
| `assistant` | The model's replies — **and, crucially, its tool_calls** | Where the model says "I want to call `check_stock`" |
| `tool` | Results fed back to the model after a tool runs | The stock data returned, appended as text for the model to read |

**Critical for Day 5:** the model doesn't *execute* anything. It *requests* a tool call in an `assistant` message. **Our code** executes it and sends back a `tool` message. That split is the whole architecture of the orchestration layer.

---

## 4. Map Every Tool/Technology to the LLM Concepts

This is the section that makes the notes a single story. Read it as: *"why does this component exist at all?"*

### 4.1 Why Postgres + the `StockView` materialized view exist
The model has **no data** (weakness #2). Postgres is the source of truth for products, orders, derived stock, and the action log. The **materialized view** precomputes `initial_stock - SUM(quantity sold)` so that when the agent asks `check_stock`, a fast, *real* number comes back — not a guess. (Refreshed after each ingestion.)

### 4.2 Why embeddings + pgvector exist (RAG retrieval)
Weakness #1 (hallucination). We can't let the model "remember" policy — it doesn't. So we **store** policy as *embeddings* in pgvector, and when a question arrives we **retrieve** the real relevant chunks, then feed them to the model as context. The vector distance **threshold** is the "grounding check": no near-enough chunk → "No relevant policy found" → the model is *prevented* from making things up. **The model never answers from its own knowledge; it answers from what we give it.**

### 4.3 Why OpenRouter / model-agnostic routing exist
The chat completions API above is a *standard*. OpenRouter exposes one endpoint for hundreds of models. Because the agent talks to a **generic chat-completions contract**, we can swap models (a dropdown) without touching our loop. This demonstrates **"no vendor lock-in"** — and directly connects to the IgniteIQ "your stack" pitch. (Risky reality: free-tier model *slugs* and *tool-call reliability* vary — Day 5's job.)

### 4.4 Why MCP + a Python tool server exist
Weaknesses #2 and #3. MCP is a **standard way to describe tools** to an LLM and let it *request* them. Each tool is just: **name + description + JSON schema**. `check_stock`, `sales_trend`, `search_policies`, `flag_reorder`, `notify_channel`. The description is what the model reads to *decide* to call a tool; the JSON schema is what it must fill in. Because our Python MCP server owns the DB access and the side effects, the model never touches the database — it only *asks*.

### 4.5 Why the tool-call loop / orchestration exists
The model predicts text; it can't run code (weakness #3). So **we** run the loop:
1. Send `system` + `user` + available tools (from MCP).
2. Model replies with `assistant` containing `tool_calls`.
3. **We** execute each call against the MCP server → get real data.
4. **We** append the result as a `tool` message.
5. Send it all back; repeat until the model answers with no more tool calls.

That loop — not the Q&A — is what makes ShopIQ an **agent**. The scheduled "weekly review" runs the exact same loop with *no user message*, so the model *plans and acts on its own*. That's the "plan, act, learn" language from IgniteIQ's own materials.

### 4.6 Why governance (ActionLog, guardrails, approval) exists
The model is fallible (weakness #1 applies to its *decisions*, not just its prose). We don't trust it to act unilaterally:
- **Every tool call** is logged to `ActionLog` (audit trail — observability).
- **Actions above a cost threshold** don't execute; they enter `pending_approval` and need a human.
- **Approval is deliberately NOT an MCP tool** — the agent cannot grant itself permission. It goes through a human UI and Telegram.
- **Telegram** makes the action land in an *external system of record* the interviewer can see and click Approve/Reject on.

### 4.7 Why temperature stays low in our code
Every call for the agent loop uses low temperature so the model reliably emits well-formed tool calls instead of drifting into prose. (Day 5 detail: if a model's output fails to parse as a tool call, that's a real, observed failure mode of free models — we verify each one against our actual tool set.)

### 4.8 Why the system prompt matters
The `system` role is where we encode the *behavioral contract* with a probability engine:
- "Cite sources when answering from `search_policies`" → fights hallucination (weakness #1).
- "State reasoning before calling `flag_reorder`" → forces auditable reasoning (weakness #1 on decisions).
- "Never flag the same product twice per cycle" → prevents loops/duplicate actions (governance).

---

## 5. The One-Paragraph Story (say this out loud)

> "ShopIQ is built around one honest fact: an LLM is a next-token predictor, not a database. That means it can't know your data, can't be trusted to remember facts, and can't take actions — so every component exists to compensate. Postgres holds real data and a materialized stock view; embeddings in pgvector retrieve only relevant, real policy chunks and a threshold stops the model from answering when nothing is relevant; MCP exposes real tools the model can *request*; our orchestration layer executes those requests in a tool-call loop; and governance — an action log, a cost threshold, and human approval — stops a probabilistic system from acting unilaterally. The result is an agent that answers from evidence and acts under guardrails, on whatever model we point it at."

That paragraph *is* the interview. Everything else is detail.

---

## 6. Glossary Terms Introduced (see also `GLOSSARY.md`)

- **Token** — atomic text unit (~3–4 chars); the pricing/context unit.
- **Autoregressive generation** — producing text one predicted token at a time.
- **Temperature** — sampling randomness knob; low = deterministic.
- **Context window** — max tokens per request; "memory" = re-sending history.
- **Hallucination** — confident-but-wrong text; the LLM's core weakness.
- **Chat completions** — the JSON request/response API we use.
- **System / user / assistant / tool roles** — the four message roles in a conversation.
- **Tool call** — the model *requesting* a function; we execute it.
- **Grounding** — answering only from retrieved evidence, never from the model's own knowledge.
- **RAG** — Retrieval-Augmented Generation: retrieve real chunks, then generate with them as context.

---

## 7. Self-Test Questions

1. Why can't you ask a plain LLM "how much stock of SKU-101 do we have?" and trust the answer?
2. What does temperature=0.1 buy you in a tool-calling system? What would temperature=1.2 break?
3. Where is the "memory" of a chat app actually stored?
4. In the agent loop, what role does *our code* play that the model can't?
5. If the nearest vector chunk is far away, why must the system refuse to answer?
6. Why is approval deliberately not exposed as an MCP tool?
