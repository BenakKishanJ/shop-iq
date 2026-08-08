# IgniteIQ Interview Prep Plan

> **For:** Benak Kishan J (final-year CS, Bengaluru) — targeting IgniteIQ (igniteiq.ai), a forward-deployed AI engineering firm.
> **Goal:** Be interview-ready in ~3–4 weeks across company knowledge, project storytelling, AI concepts, DSA, and behavioral answers.
> **Primary weapon:** ShopIQ project — its stack (Next.js/TS + Python + RAG + MCP + pgvector + governance) matches IgniteIQ's confirmed stack almost 1:1. Very few freshers can say they've built an MCP server. Lead with this.

---

## 0. Context & Assumptions

**You (per profile):** Python, JS/TS, Go (learning), C++/Java (academic); Express/Node, Flask, FastAPI; React, Next.js, Tailwind; intermediate LeetCode; learning tool calling, MCP, RAG, vector DBs.

**IgniteIQ (from IgniteIQ.md):**
- Forward-deployed AI engineering firm (not SaaS). Pod model: architect + fractional CTO + AI-augmented engineers embedded client-side. Phases: Discover → Co-Design → Deliver & Adopt.
- Pitch keywords: *"weeks not quarters"*, *"your IP, your stack"*, *"measured against ROI, not hours"*.
- Live products: Answer Assistant (cited grounded answers), DeepSight (multi-step research agents), TLDR-IQ (doc synthesis), Data Booster. IQ Agent Platform = coming soon.
- 8 case studies; team ~11 people (loose data — do not repeat in interview).
- Category context: "forward-deployed engineer" originated at Palantir (~2010s); OpenAI scaled the model in 2026.

**ShopIQ facts verified from code (use these exact details in answers):**
- FastAPI backend (`main.py`), agent loop calls OpenRouter LLM; `ThreadPoolExecutor(4)` keeps `/api/health` responsive while blocking LLM calls run (async MCP + sync HTTP → event-loop blocking problem, solved).
- MCP server via `mcp` Python SDK **FastMCP**, stdio transport; function signature → inputSchema, docstring → tool description the LLM reads. Tools: `search_policies`, `check_stock`, more.
- RAG: policy docs → chunk → embed via OpenRouter `/embeddings` (batched 20/request) → stored in **pgvector** → `ORDER BY embedding <=> :query LIMIT k` (cosine distance) in `search_policies.py`.
- Governance: every tool call logged to `action_log`; actions flagged above `APPROVAL_THRESHOLD` (e.g. reorders) go `pending_approval` — human approves via `approve_action` / `/api/actions/<id>/resolve`, with Telegram notify. Human-in-the-loop guardrails.
- API surface: `/api/chat` (frontend ↔ agent loop), `/api/policies` (dynamic policy library), `/api/actions` (governance trail). Frontend: Next.js on :3000, CORS configured.
- Docs to re-read: `PRD.md`, `DD.md` in `~/Projects/shop-iq/`.

**Assumption on interview format (verify):** likely 1st round = screening (DSA + project walkthrough + AI basics), 2nd = technical deep-dive (system design lite + AI), 3rd = behavioral + culture (small team = culture fit matters a lot).

---

## 1. Phase 0 — Company Research (Days 1–2, ~1–2 hrs/day)

**Task 0.1: Build a one-page cheat sheet** (distill IgniteIQ.md §1–§6 into bullet points you can recall cold):
- The pitch (3 bullets), pod model, 3 phases, 4 live products + 1 coming soon, 8 case studies.
- Memorize **3 case studies** in depth — pick: Construction RAG risk-intel (governance angle), Enterprise SaaS support co-pilot (6-week build, 70% faster resolution, 60% productivity gain), Pharma visual QA (80% less manual verification). For each: problem → build → metric.

**Task 0.2: Master the category story.** Know this arc: Palantir coined forward-deployed engineering → gen-AI pilots failing to reach production → consultancies don't close the execution gap → OpenAI backs deployment-focused entity (2026). Answer to *"Why IgniteIQ?"* must show you understand this, not "I saw your website."

**Task 0.3: Prep your 5 questions for them** (from IgniteIQ.md §9):
1. How is a pod staffed — do juniors work directly with clients or support the architect?
2. Dedicated MCP server per client, or shared tool integrations across engagements?
3. How does "your stack, no lock-in" hold up when clients lack vector-search infra?
4. What does Governance & Trust look like in practice — audit logs, human-approval workflows?
5. (Add one of your own — e.g. how they evaluate agent quality/ROI per engagement.)

**Deliverable:** cheat sheet you can glance at and recall 90% cold.

---

## 2. Phase 1 — ShopIQ Project Mastery (Days 3–5, ~2 hrs/day)

**Task 1.1: Write your 2-minute pitch.** Structure: problem (store policies + inventory scattered, support answers inconsistent) → what I built (chat over policies with cited answers + agent tools + human approval) → how (RAG → pgvector → MCP tools → agent loop → governance) → my role (full-stack, solo) → results/metrics (quantify: N documents, N chunks, response latency, approval flow). Practice out loud until it's 2:00±15s. **Never mention "just a college project."**

**Task 1.2: Re-read the code you'll be grilled on** — you must answer line-level questions:
- `backend/main.py` (threadpool reasoning — great "engineering tradeoff" story)
- `backend/mcp_server.py` (FastMCP tool design)
- `backend/search_policies.py` + `backend/embeddings.py` (retrieval pipeline, batching)
- `backend/ingest_policies.py` (chunking strategy — chunk size? overlap? why?)
- `backend/governance.py` (threshold logic, pending_approval flow)
- `backend/agent.py` (agent loop: prompt, tool selection, how OpenRouter calls happen)
- `frontend/src` (how chat UI wires to `/api/chat`)

**Task 1.3: Prepare answers to these likely questions** (write them out, then say them aloud):
1. Why RAG and not fine-tuning? (fresh data, no retraining, citations, cost)
2. Why pgvector over a dedicated vector DB? (same Postgres, transactions with relational data, zero extra infra — good "startup-appropriate" answer)
3. How did you chunk documents and choose embedding model? (be honest about what you did and what you'd change)
4. How do you guarantee answers are grounded/cited? (retrieval + prompt constraint + governance log)
5. What is MCP and why does it matter? (protocol standardizing agent↔tool; you built a server with stdio transport; Claude Desktop connects)
6. Walk me through the human-in-the-loop approval flow. (threshold → pending → approve via API → Telegram notify — this is *exactly* IgniteIQ's "Governance & Trust" pillar)
7. What breaks at 10× the data? (indexing time, latency, chunk quality, embedding cost — have 3 concrete answers)
8. How would you evaluate this RAG system? (retrieval: hit rate/MRR; generation: faithfulness; user feedback loop)
9. Why the threadpool? (sync HTTP in async MCP blocks event loop → API unresponsive; tradeoff: complexity vs responsiveness)
10. What would you build next? (reranking, hybrid keyword+semantic search — *they built exactly that in a case study*, evaluation harness, streaming)

**Task 1.4: Prepare 2 STAR stories** (situation→task→action→result, 90s each):
- A hard bug/technical struggle in ShopIQ (e.g. event-loop blocking, embedding cost, chunking quality) and how you debugged it.
- A design decision with tradeoffs you owned (e.g. threadpool, pgvector choice, governance threshold).

**Deliverable:** pitch script + 10 Q&A answers + 2 STAR stories, written in `notes/` of the repo or a doc you can rehearse from.

---

## 3. Phase 2 — AI Concepts Crash Course (Days 6–10, ~1.5 hrs/day)

**Task 2.1: RAG (2 days).** Indexing pipeline (ingest → clean → chunk → embed → index); chunking strategies (size, overlap, semantic); embedding models & dimensions; vector search (cosine vs dot vs euclidean); hybrid search (keyword + semantic — name it: BM25 + dense, like their case study); reranking (cross-encoders); evaluation (hit rate, MRR, nDCG, faithfulness/groundedness); hallucination mitigation (citations, abstain, confidence thresholds).

**Task 2.2: MCP & tool calling (2 days).** MCP architecture: host, client, server; primitives — tools, resources, prompts; transports (stdio vs streamable HTTP/SSE); why standardization matters (one protocol, many clients — Claude Desktop, agents); how a tool call flows: LLM → tool_use → execute → result back. Agent loop: ReAct (reason-act-observe), multi-step planning (DeepSight = multi-step research agent), when agents fail (error recovery, loops, cost). You already built one — connect every concept to your code.

**Task 2.3: LLM fundamentals + vector DBs (1 day each).** Tokens/context windows, temperature/top-p, structured output (JSON mode, function calling), prompt engineering vs fine-tuning, embeddings intuition (semantic space). Vector DBs: exact vs ANN, HNSW/IVF, distance metrics, metadata filtering, pgvector vs Qdrant/Pinecone/Chroma/Weaviate — tradeoffs table.

**Task 2.4: Self-quiz.** I'll quiz you (say the word) — or use Anki-style flashcards from the cheat sheet. Target: answer any concept question in 2–3 sentences with a ShopIQ tie-in.

**Deliverable:** one-page AI concepts cheat sheet + ability to answer any of ~20 likely questions.

---

## 4. Phase 3 — DSA Sprint (Daily, 45–60 min, through the whole window)

Intermediate LeetCode → move from *solving* to *pattern recognition + speed*.

**Task 3.1: Pattern-first practice.** Cover in order (2–3 problems/day, Neetcode 150 / Blind 75 style):
1. Arrays & Hashing (prefix sums, frequency maps)
2. Two Pointers & Sliding Window
3. Binary Search (incl. rotated arrays)
4. Linked Lists (fast/slow pointer)
5. Trees & Graphs — BFS/DFS (priority; AI/agent questions love graphs)
6. Heaps / Top-K
7. Intervals
8. DP basics (1D; skip heavy DP unless time)
9. Backtracking (permutations/subsets — common in interviews)

**Task 3.2: Speak while you solve.** Verbalize approach → complexity → edge cases before coding (matches their "decisions in the room" culture).

**Task 3.3: Two system-design-lite questions** (startups ask these for full-stack/AI roles): (a) design a RAG-based Q&A service at scale (indexing pipeline, caching, rate limits, observability), (b) design a customer support agent with tool access + human approval (you've literally built this — map ShopIQ to it, then scale it: queue, workers, idempotency, audit).

**Deliverable:** ~40–50 problems done with pattern tags; fluent complexity analysis.

---

## 5. Phase 4 — Behavioral + Mock Interviews (Final Week)

**Task 4.1: Write & rehearse these answers:**
- *Tell me about yourself* (60s: CS final-year → full-stack + AI interests → ShopIQ → why IgniteIQ).
- *Why IgniteIQ?* (forward-deployed model + "weeks not quarters" + your ShopIQ = proof you can ship agentic AI; small team = you want ownership)
- *Why forward-deployed engineering / why AI?* (category story from Phase 0)
- *Strengths / weaknesses* (weakness: Go/scale experience — with a growth plan, never a cop-out)
- *Where do you see yourself in 2 years?* (embedded engineer owning client agent deployments)
- *Do you have questions for us?* (5 from Phase 0)

**Task 4.2: Three full mock interviews with me** (schedule them):
1. Mock #1: AI concepts + ShopIQ deep-dive (60 min)
2. Mock #2: DSA session (45 min, timed)
3. Mock #3: Behavioral + company fit (45 min)
- After each: I give structured feedback (what went well / what to fix / likely scores).

**Deliverable:** 6 polished answers + 3 mock runs with feedback incorporated.

---

## 6. Weekly Time Budget (3–4 weeks)

| Day | DSA (45–60m) | AI concepts (30–45m) | Project/Company (30–60m) |
|-----|-------------|---------------------|--------------------------|
| Mon–Fri | Pattern problems | 2.1–2.4 sections | Pitch/STAR/cheat sheet |
| Sat | Timed contest (1 problem, 45m) | Review flashcards | Mock interview (Phase 4) |
| Sun | Rest / weak patterns | Rest | Rest |

**Milestones:**
- End of Week 1: cheat sheet + pitch + 10 Q&As drafted → mock #1 scheduled
- End of Week 2: AI concepts done + 20–25 DSA problems → mock #2
- End of Week 3: STAR stories polished + 40–50 DSA → mock #3
- Interview day: cheat sheet + pitch + STAR stories in one doc, rehearse 15 min that morning

---

## 7. Risks & Open Questions

- **Unknown interview format** — ask the recruiter: rounds? DSA-heavy or project-heavy? Is it the founder/CTO interviewing (small team → likely)? Adjust Phase 3/4 weight.
- **Go is listed as "learning"** — if Go appears, say it plainly with what you've built in it; IgniteIQ stack is Python/TS so risk is low.
- **"Coming soon" IQ Agent Platform** — don't claim it exists; saying "I know it's listed as coming soon — what's the roadmap?" is a *great* question.
- **Metrics for ShopIQ** — if you don't have real numbers (latency, chunk counts), instrument them this week (`notes/` has context) — quantified beats qualitative in every interview.
- **Don't overclaim** — insider stack info from your contact is for *your* credibility, never quoted as if public.

---

## 8. Files to Keep in Your Prep Workspace

- `IgniteIQ.md` (source of truth for company)
- `PRD.md`, `DD.md` (project docs — re-read before mocks)
- This plan
- New: `notes/company-cheatsheet.md`, `notes/pitch-and-qa.md`, `notes/star-stories.md`, `notes/ai-concepts-cheatsheet.md`
