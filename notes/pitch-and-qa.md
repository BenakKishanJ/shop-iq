# ShopIQ — 2-Minute Pitch + Talking Points

> **Purpose:** the pitch you give for *"walk me through your project."* Drill until 2:00 ± 15s at natural pace (~150 wpm ≈ 280–300 words).
> **All facts below are verified from your code & notes** (`ARCHITECTURE-OVERVIEW.md`, `agent.py`, `mcp_server.py`, `main.py`) — every number is defensible.

---

## 1. The 2-Minute Pitch (memorize this)

> **Hook:** "ShopIQ is an AI store-operations co-pilot for retail — you ask questions in plain English, and it answers with **cited facts from real data and policy documents**, and can even take actions — **under human approval**."
>
> **Problem:** "Retail ops teams have two disconnected worlds: **scattered policy documents** (returns, refunds, pricing) and **messy transactional data** in spreadsheets. Generic chatbots either hallucinate answers or can't touch live numbers, so support and operations stay manual and slow."
>
> **What I built:** "A full-stack agentic system — **Next.js** frontend, **FastAPI** backend, and an **agent loop** that uses tools through **MCP (Model Context Protocol)**, with **RAG** grounding policy answers in documents."
>
> **How it works (the meat):**
> "Under the hood there are two data flows into one **PostgreSQL + pgvector** database. The structured side: a real retail dataset of **525,000 rows**, cleaned down to **407,000** — about **4,000 products, 19,000 orders, 394,000 line items**. The unstructured side: **6 policy documents** chunked into **19 citable sections**, embedded as **2048-dim vectors**.
>
> "Retrieval embeds the question with the **same embedding model** and ranks chunks by **cosine distance** — my favourite proof: a query like *'my charger stopped working, do I have any recourse?'* shares **zero words** with the documents, yet it surfaces the right policies. That's semantic retrieval, not keyword matching.
>
> "On top of that sits an **MCP server exposing 10 tools** — `check_stock`, `sales_trend`, `top_sellers`, `search_policies`, `flag_reorder`, and more. The agent loop converts those MCP tools into OpenAI function-calling schema, calls an LLM via OpenRouter, and iterates up to 5 times: reason → act → observe → answer.
>
> "The part I'm most proud of is **governance**: every tool call is audit-logged, and any action above a risk threshold — like a reorder — goes to **pending approval** instead of executing. A human approves through the API, with a Telegram notification. The agent can act, but it can't run wild."
>
> **My role:** "I designed and built this end-to-end — data pipeline, retrieval, MCP server, agent loop, governance, and the frontend chat UI."
>
> **Close (tie to them):** "And the stack — **Next.js, Python, RAG, MCP** — is exactly what IgniteIQ ships in production. Building it taught me what it actually takes to get agentic AI working *reliably*: grounding, tool discipline, and guardrails — not just calling a model."

**Word count target:** the meat section is the only one you can trim — cut the pipeline numbers first, keep the semantic-retrieval proof and the governance story (those are your differentiators).

---

## 2. The 30-Second Elevator Version

> "ShopIQ is an AI co-pilot for retail ops. Ask it anything in plain English — it answers from **live sales data and policy documents with citations**, using RAG for grounding and an **MCP tool server** so the agent can check stock, analyze trends, and flag reorders. The differentiator is **governance**: risky actions need human approval, and every tool call is logged. Built end-to-end with Next.js, FastAPI, Python, and pgvector."

---

## 3. Facts to Defend (know these cold — interviewers will probe)

| Claim | Truth (from code) |
|---|---|
| Dataset size | `online_retail_II.xlsx`, 525,461 rows → **407,050** clean (cancellations/nulls/junk dropped) |
| Products / orders / items | **4,011** / **19,040** / **394,389** (idempotent upserts, one transaction) |
| Stock derivation | No live inventory field → `stock_view` MV computes `initial − SUM(sold)`, floored at 0 — **assumption documented, not hidden** |
| Policy corpus | **6 docs → 19 chunks**, each `Title — Section:` + body, 2048-dim vectors |
| Embeddings | OpenRouter `/embeddings`, **batched 20/request**, single client in `embeddings.py` = the swap point |
| Retrieval | `ORDER BY embedding <=> :query LIMIT 5` (cosine distance), top-k = 5 |
| MCP server | `FastMCP` SDK, **stdio transport**, 10 tools, signature → inputSchema, docstring → tool description |
| Agent loop | MCP client discovers tools (`tools/list`) → converts to OpenAI schema → LLM via OpenRouter → **max 5 iterations** |
| Governance | Every call → `action_log`; above `APPROVAL_THRESHOLD` → `pending_approval`; human approves via `approve_action` / `/api/actions/<id>/resolve`; Telegram notify |
| Concurrency decision | Sync LLM calls inside async MCP would block the event loop → **`ThreadPoolExecutor(4)`** keeps `/api/health` responsive |
| Frontend | Next.js on :3000 → `/api/chat` (CORS scoped to localhost:3000) |

---

## 4. Delivery Notes

- **Hook in under 10 seconds** — start with "AI co-pilot for retail," not "I made a project about..."
- **Pause before the semantic-retrieval proof** — it's your best "wow," let it land.
- **Never say "just a college project"** — you built a production-shaped system (logging, governance, concurrency handling, idempotent ingestion).
- **If they interrupt with a technical question** — answer it, then return with "and that connects to...".
- **Have a metric you'd add**: if they ask "how do you know it works?", be ready with the eval you *would* build (Phase 2 of prep covers this).

---

## 5. ⚠️ Honesty Box — the Mentor Program (read this)

Your notes say ShopIQ was built through a **"ShopIQ Mentor Program"** (Day 1–7 structure). Interviewers may ask *"did you build this alone?"* — **do not misrepresent, and do not volunteer it either.** Prepared honest answers:

- *"It was part of a structured build program where I was guided on architecture, but I wrote the code and I can defend every line — the data pipeline, MCP server, agent loop, and governance are mine."*
- If they press on guidance: *"The mentor set the weekly milestones; the engineering decisions — like the threadpool, pgvector over a dedicated vector DB, and the approval-threshold design — were mine."*

**Rule:** only *you* know how much was guided vs. solo. Whatever the truth, say it confidently and pivot to what you own and understand deeply. Never claim solo ownership of parts you didn't write.

---

## 6. Next Steps in Phase 1 (your homework)

1. **Read it aloud 3×** — time yourself; trim to 2:00.
2. **Re-read the code** (Task 1.2 checklist): `main.py`, `agent.py`, `mcp_server.py`, `search_policies.py`, `embeddings.py`, `ingest_policies.py`, `governance.py` — you must survive line-level questions.
3. **Instrument real metrics** (if you want numbers): count chunks in DB, time one `/api/chat` round-trip, count tool calls in `action_log`. Quantified > qualitative.
4. **Task 1.3 DONE** — the 20 likely interview questions with model answers are in section 7 below. Drill them like the pitch: read aloud, then answer from memory.

---

## 7. The 20 Likely Interview Questions (with model answers)

> **How to use:** cover the answer, say it aloud, then check. Every answer is grounded in your real code — the follow-ups are the ones interviewers actually probe with. Mark ones you stumble on; drill those twice.

### A. Overview & Motivation

**Q1. "Walk me through your project."**
*What they're testing:* can you communicate scope in 2 minutes, structured.
**Answer:** Use the 2-minute pitch (section 1). Then STOP talking and let them ask.

**Q2. "Why did you build this? What real problem does it solve?"**
*What they're testing:* motivation + product thinking.
**Answer:** "Retail ops teams have two disconnected worlds — policy documents scattered across files (returns, refunds, pricing), and transactional data locked in spreadsheets. Answering a customer question or deciding a reorder means hunting through both. Generic chatbots either hallucinate answers or can't touch live numbers. ShopIQ is one system where you ask in plain English and get a cited answer from the policies *and* live data — and when the agent takes an action like flagging a reorder, it's logged and needs human approval."

**Q3. "Why RAG instead of fine-tuning the model on your policies?"**
*What they're testing:* do you understand the RAG-vs-fine-tuning tradeoff, not just the buzzword.
**Answer:** "Policies change constantly — new returns rules, updated pricing. RAG means the knowledge lives in the database, not in model weights: update the document, re-ingest, done — no retraining, no version skew. It also gives citations, which fine-tuning can't: every claim traces back to a source chunk, which is what makes the governance story possible. Cost too — no training runs. Fine-tuning is for style or domain behavior, not facts; if I wanted the model to *sound* like a store assistant I'd fine-tune on top of RAG, not instead of it."
*Follow-up:* "What if a policy question needs synthesis across 10 documents?" → "That's still RAG-able — retrieve more chunks, let the model reason over them; fine-tuning wouldn't help there either."

### B. Data Pipeline & Ingestion

**Q4. "Walk me through your data pipeline — you said 525,000 rows?"**
*What they're testing:* end-to-end data engineering + whether numbers are real.
**Answer:** "A real retail transactions dataset, 525,461 rows in Excel. First `clean_sales()`: validate columns, drop cancellations, nulls and junk, normalize identifiers to strings, drop bad prices — down to 407,050 clean rows. Then one transaction loads it: products upsert on SKU (4,011), orders insert-if-absent (19,040), order_items upsert that *accumulates* quantity on conflict (394,389), then `REFRESH MATERIALIZED VIEW stock_view`. The dataset has no live inventory field, so stock is derived as initial stock minus sum of sales, floored at zero — that assumption is documented in the code, not hidden."
*Follow-up:* "Why one transaction?" → "Atomicity — a failure mid-load can't leave half-loaded data. Auto-commit or rollback."

**Q5. "What happens if you run your load twice? Or re-ingest the same policy doc?"**
*What they're testing:* idempotency — a favorite of production-minded interviewers.
**Answer:** "Nothing breaks. Every write path uses `ON CONFLICT` upserts, so re-running merges instead of duplicating — products update, orders stay, line-item quantities accumulate correctly, counts stay stable. For documents, `upsert_document` does an `ON CONFLICT (title) DO UPDATE`, then deletes that doc's old chunks and inserts fresh ones — replace-on-reingest. Queries never see stale versions, and the corpus always reflects the current source."

**Q6. "How do you chunk documents, and why that strategy?"**
*What they're testing:* retrieval fundamentals — chunking is where RAG quality lives or dies.
**Answer:** "Section-aware, not fixed-size. `parse_sections` splits each policy on `## Heading` blocks, and each (heading, body) pair becomes one citable chunk — `'Title — Section:\nbody'` — with a chunk index. Text before the first heading becomes an Introduction. Why: citations become section-level ('[Return Policy :: Opened Electronics]'), the heading context travels with the chunk, and it plays nicely with the governance trail. Tradeoff I'd revisit at scale: a very long section becomes one big chunk, so I'd sub-chunk long sections with overlap, or move to semantic chunking."
*Follow-up:* "Why no overlap?" → "Sections are the natural boundary here; overlap matters more for fixed-size splits of continuous text like manuals."

**Q7. "Why pgvector instead of a dedicated vector database like Pinecone or Qdrant?"**
*What they're testing:* infrastructure judgment — the answer they want is *reasoned*, not trendy.
**Answer:** "Because the vectors live right next to the relational data they describe. Chunks join to `policy_documents`, and the same Postgres holds products, orders, and the action log — one database, real transactions, zero extra infrastructure. For 19 chunks today, a dedicated vector DB is pure overhead. That's a deliberate, startup-sized tradeoff: pgvector handles it comfortably, and if we ever hit millions of vectors I'd add an HNSW index in pgvector first, and only migrate to a managed vector DB when scale or multi-tenancy actually demands it. The swap is contained — embeddings go through one client module."

### C. Retrieval & RAG

**Q8. "Explain your retrieval end-to-end. Why does semantic search work here?"**
*What they're testing:* do you actually understand embeddings + similarity search.
**Answer:** "The question gets embedded with the *same* model that embedded the corpus — that's critical, query and document must live in the same vector space. Then `ORDER BY embedding <=> :query LIMIT 5` — cosine distance — returns the nearest chunks. My favorite proof it's semantic, not keyword: the query *'my charger stopped working, do I have any recourse?'* shares zero words with the documents, yet it surfaces 'Defective Items' and 'Opened Electronics'."
*Follow-up:* "What distance metric and why?" → "Cosine (`<=>` in pgvector) — it measures direction, not magnitude, which is robust to chunk length differences. Embeddings are normalized in practice, so it also equals dot product."

**Q9. "What is the grounding threshold, and how did you choose it?"**
*What they're testing:* the hallucination-prevention detail most people skip.
**Answer:** "`rag_answer.py` checks the best match's distance against `DISTANCE_THRESHOLD = 0.80` before generating. I tuned it from live retrieval runs — strong matches land around 0.35, weak or irrelevant ones at 0.80+. If the best hit is beyond the threshold, the system refuses with 'No relevant policy found' and **doesn't call the LLM at all** — zero cost, zero hallucination risk. It's a config constant because the right value depends on the embedding model."

**Q10. "How do you prevent the LLM from hallucinating?"**
*What they're testing:* layered defenses, not one magic trick.
**Answer:** "Four layers. One: retrieval is the only knowledge source — if nothing is close enough, we refuse before the LLM is even called. Two: the system prompt forbids outside knowledge — answer ONLY from provided sources, cite each claim in the exact verbatim format `[doc title :: section]`. Three: temperature 0.2, so output stays close to the evidence. Four: if the sources don't contain the answer, the model must say exactly 'This is not covered by the available store policies' — and the frontend parses and renders those citations so a human can verify every claim."

**Q11. "How would you make retrieval better?"**
*What they're testing:* growth mindset + knowledge of the RAG toolkit.
**Answer:** "Three things. First, **hybrid search** — combine the dense vector search with keyword search (BM25-style) and fuse the rankings; that catches exact terms like SKUs and product names that embeddings can blur. Second, **reranking** — retrieve 20 candidates cheaply, then a cross-encoder reranks the top 5. Third, an **evaluation harness** — a labeled set of questions with the expected policy sections, measuring hit rate and MRR, so every change is measured instead of vibes."
*(Interviewer note: hybrid search is literally one of IgniteIQ's case studies — say it with confidence.)*

### D. MCP & Agent Loop

**Q12. "What is MCP, and why did you build your agent around it?"**
*What they're testing:* do you understand the protocol's *why*, not just the name.
**Answer:** "Model Context Protocol is an open standard for connecting LLMs to tools and data — it defines a host, a client, and a server, with primitives like tools, resources, and prompts. I built the server with the FastMCP SDK over stdio transport: each `@server.tool` function's signature becomes the inputSchema and its docstring becomes the description the LLM reads. Why MCP: it decouples the tool surface from the agent logic — the same server speaks to Claude Desktop, my agent loop, or anything else that speaks MCP. My agent even converts the MCP tool catalog into OpenAI function-calling schema, so the tools are model-agnostic too."

**Q13. "Walk me through your agent loop."**
*What they're testing:* do you understand tool-calling agents, or did you copy the code.
**Answer:** "The agent spawns `mcp_server.py` as a subprocess over stdio, opens an MCP client session, and calls `list_tools` — it discovers the 10 available tools rather than hardcoding them. Each tool is converted to OpenAI function-calling schema, and the conversation goes to the LLM via OpenRouter with `tools` attached. If the reply contains `tool_calls`, the agent executes them through the MCP client and feeds the results back into the conversation — reason, act, observe — repeating up to `MAX_ITERATIONS = 5`, then returns the final answer plus a record of every tool it used."
*Follow-up:* "Why 5?" → "A hard cap bounds cost and prevents runaway loops; well-designed prompts and tools should resolve in 2–3 turns."

**Q14. "What stops the agent from going off the rails — looping, or calling the wrong tool?"**
*What they're testing:* failure modes — production thinking.
**Answer:** "Several mechanisms. The iteration cap bounds runaway loops. The system prompt encodes tool discipline — never guess numbers or SKUs; resolve a product description to a SKU via `search_products` *before* checking stock; report only real returned numbers; say so honestly when data isn't found. The governance layer records every call in `action_log`, so misuse is visible and replayable. And the approval threshold means even a *correctly* called risky action — a large reorder — still can't execute without a human."
*Follow-up:* "What if the LLM API fails mid-loop?" → "`llm.py` retries 429/5xx with exponential backoff up to 3 attempts, respecting `Retry-After`; non-transient errors fail loudly rather than silently returning garbage."

**Q15. "You used a ThreadPoolExecutor in the API — why?"**
*What they're testing:* async/concurrency understanding — this is a *great* question to be asked.
**Answer:** "The agent loop makes synchronous HTTP calls to OpenRouter, but it runs inside async MCP code on the event loop. If I awaited it directly on the loop, every in-flight chat request would block `/api/health` and everything else — one slow LLM call would freeze the API for all users. So `main.py` offloads the loop to a `ThreadPoolExecutor(max_workers=4)`: the API stays responsive, and the pool bounds concurrent LLM calls. The tradeoff: bounded concurrency and a shared pool across the chat and ingest paths — fine for this scale, and I'd move to a proper job queue if traffic grew."

### E. Governance & Safety

**Q16. "Explain your governance system."**
*What they're testing:* can you design safe agents — the #1 thing IgniteIQ sells.
**Answer:** "It's audit-first plus a materiality threshold. Every MCP tool call — reads *and* writes — is inserted into `action_log` with the tool name, arguments, result, and reasoning, so you can replay exactly what the agent did. Then the approval matrix: `flag_reorder` with a suggested quantity above `APPROVAL_THRESHOLD = 300` is *not* executed — it's recorded as `pending_approval`, and a human approves or rejects it via the API (`/api/actions/<id>/resolve`), which cascades the decision to the reorder flag. Notifications go to Telegram when a bot token is configured, otherwise to a stub table — same integration point either way. The design is borrowed from financial controls — SOX-style approval matrices — applied to an AI agent."
*Follow-up:* "Why log reads too, not just writes?" → "The trail is the ground truth of *what the agent did*, which is what a reviewer wants to see — audit-first, not audit-on-write."

**Q17. "Why does human-in-the-loop matter for agents?"**
*What they're testing:* safety judgment + business sense.
**Answer:** "Blast radius. Small actions — a stock lookup, a policy search — auto-run because failure costs nothing. A large reorder moves money and inventory, so it needs a human. That's not friction, it's trust: the approval step is what lets a business let an agent act at all, and the audit log is the accountability layer on top. It's also a genuine product differentiator — this is exactly the 'Change Management, Governance & Trust' pillar IgniteIQ sells, and I built a working version of it."

**Q18. "Why do you have two answer paths — `rag_answer.py` and the agent?"**
*What they're testing:* do you understand when to use a deterministic pipeline vs. an agent.
**Answer:** "They solve different problems. The RAG path is deterministic grounded QA: retrieve → threshold check → cited answer, no tools, low cost, ideal for 'what does our policy say' questions where you want a strict, reproducible answer. The agent path is for questions that need *action* — check live stock, analyze trends, resolve a description to a SKU, flag a reorder — it plans across tools with up to 5 iterations. `/api/chat` routes through the agent loop, and the agent itself calls `search_policies` as one of its tools, so both capabilities compose. The RAG path exists because sometimes you want the answer *without* the machinery."

### F. Architecture & Scaling

**Q19. "What breaks at 10× the data, and how do you scale?"**
*What they're testing:* systems thinking — this is where freshers usually go blank.
**Answer:** "Five things. One: embedding cost and rate limits — I'd batch smarter, cache embeddings, and dedupe chunks. Two: indexing time — parallelize ingestion and make it incremental instead of replace-all. Three: retrieval latency — at hundreds of thousands of vectors I'd add an HNSW index in pgvector; at millions, migrate to a managed vector DB. Four: chunk quality degrades on messier documents — better cleaning and semantic chunking. Five: the agent path is LLM-bound and the threadpool caps concurrency at 4 — I'd move long-running agent jobs to a queue with workers, add per-user rate limiting, and watch p95 latency and cost per query in observability."

### G. Evaluation & Future Work

**Q20. "How would you evaluate ShopIQ? What would you build next?"**
*What they're testing:* evaluation maturity — most candidates have never thought about it.
**Answer:** "Evaluation first: a labeled set of questions with expected policy sections and answers, then measure retrieval hit rate and MRR, answer faithfulness, refusal accuracy — does it correctly refuse out-of-corpus questions — plus p95 latency and cost per query. Then I'd iterate: hybrid search and reranking (Q11), an eval harness wired into CI, streaming responses, and a user feedback loop ('was this helpful?') to grow the labeled set. Product-wise: more tools like returns processing, multi-user auth, and hardening the deployment — the backend's already Dockerized, so the frontend to Vercel and the DB to a managed Postgres would finish it."
*Follow-up:* "How do you measure faithfulness?" → "Take the answer, check every cited section actually supports the claim — either an LLM-as-judge on a sample, or grounding metrics against the source chunks; plus human review of a sample."
