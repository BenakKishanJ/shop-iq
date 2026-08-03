# ShopIQ — Product Requirements Document (PRD)

**Version:** 1.0
**Author:** Benak Kishan J
**Status:** Draft — Interview Portfolio Project
**Last updated:** August 2026

---

## 1. Overview

ShopIQ is an agentic AI co-pilot for small-to-medium retail businesses. It grounds every answer in a store's own documents and live transaction data using Retrieval-Augmented Generation (RAG), and — unlike a standard chatbot — can take real actions on the store's systems through the Model Context Protocol (MCP): checking stock, surfacing sales trends, and flagging restocks, with every autonomous action logged and gated behind configurable guardrails.

This project is built to demonstrate the same engineering pattern used by forward-deployed AI consultancies: unstructured + structured client data feeding a grounded retrieval layer, wired to an agent that can both answer and act — shipped as a small, production-shaped system rather than a notebook demo.

## 2. Problem Statement

Small-to-medium retailers generate real operational data — sales history, supplier terms, return policies, compliance checklists — but it lives in disconnected places: a POS export nobody analyzes, and a folder of PDFs nobody reads. Staff either guess or waste time digging for answers, and slow-moving or understocked items go unnoticed until they become a real problem. There is no single system that understands both the store's documents and its transaction data, and can act on that understanding.

## 3. Goals & Non-Goals

**Goals**

- Ground every AI answer in real store data — no hallucinated policy or stock answers, always cited.
- Give the agent the ability to act (flag a reorder, log an escalation), not just answer questions.
- Demonstrate an agent that plans autonomously (a scheduled review), not only reacts to direct questions.
- Build in governance from day one: every autonomous action is logged and approval-gated above a threshold.
- Keep the system small enough to build, run, and demo end-to-end in roughly 3–4 weeks.

**Non-Goals (explicitly out of scope)**

- Multi-tenant / multi-store SaaS product with auth and billing.
- Mobile app or native client.
- Multi-language support.
- Real POS/inventory system integration — a simulated backend, seeded with real transactional data (and reseedable via the upload page), stands in for this.
- General-purpose file storage — uploads are limited to the sales spreadsheet and policy-document formats needed to drive the demo, not an arbitrary document management system.

## 4. Target User / Persona

**Primary:** Owner or senior staff member of a small-to-medium retail shop (1–10 employees) who currently manages inventory and policy knowledge through spreadsheets, memory, and paper or PDF documents.

**Secondary (for the interview framing):** An evaluator assessing whether this system reflects the same problem-solving pattern used in production forward-deployed AI engagements — grounded retrieval, agentic tool use, and governance, applied to a real, well-scoped business problem.

## 5. Feature Requirements

Priority key: **P0** = must-have for demo, **P1** = strong addition if time allows, **P2** = stretch goal.

### 5.1 Grounded Q&A (RAG) — P0

- Users can ask natural-language questions about store policy, supplier terms, or compliance rules.
- Every answer cites the specific source document/section it was grounded in.
- If no relevant document is found, the system says so rather than guessing.

### 5.2 Structured data tools — P0

- `check_stock(product)` — returns current derived stock level for a product.
- `sales_trend(product, period)` — returns sales volume/revenue over a given period.
- Both are exposed as MCP tools the agent can call mid-conversation, not hardcoded UI buttons.

### 5.3 Agent actions — P0

- `flag_reorder(product, quantity, reasoning)` — agent-initiated action that writes a reorder flag with its own stated reasoning attached.
- Actions above a configurable cost/quantity threshold require human approval before taking effect (see 5.5).

### 5.4 Proactive review (agentic planning) — P0

- A scheduled job (simulating a "weekly review") runs the agent without a user prompt: it scans products, cross-references `sales_trend` against `check_stock`, decides which items need attention, and calls `flag_reorder` on its own. This is the core distinction between a tool-using chatbot and an agent that plans.

### 5.5 Governance & guardrails — P0

- Every tool call and every action is written to an immutable action log (what was called, with what arguments, what it returned, and — for actions — the agent's stated reasoning).
- Actions above a defined threshold enter a "pending approval" state instead of executing immediately.
- A simple UI view lets a human approve or reject pending actions.
- **Telegram notifications** are sent for actions that require approval (e.g., `flag_reorder`), with inline **Approve** / **Reject** buttons; the approval UI updates both the DB and the Telegram message status.
- All Telegram messages are also recorded in an immutable `TelegramMessages` table for full auditability.

### 5.6 Dashboard — P0

- Chat interface for direct Q&A.
- Low-stock / pending-reorder panel.
- Action log / audit trail view.
- Pending Telegram notifications panel with inline Approve/Reject buttons.

### 5.7 Hybrid retrieval — P1

- Combine keyword filtering with semantic (vector) search for retrieval, rather than pure vector similarity — improves precision on exact terms like SKU codes or policy names.

### 5.8 Support ticket clustering — P2 (stretch)

- Synthetic support tickets are embedded and clustered to surface recurring issue categories, mirroring root-cause analytics over unstructured text.

### 5.9 Data upload & test-state management — P0

- A dedicated `/data` page lets the user upload a sales spreadsheet (CSV/XLSX) to replace or extend the transaction dataset, and upload one or more policy documents (PDF/DOCX/TXT) to replace or extend the RAG corpus.
- Uploading triggers re-ingestion — structured data is re-loaded into Postgres and the derived stock view recalculated; documents are re-chunked and re-embedded — without touching code or the database directly.
- The page shows a summary of what's currently loaded (row counts, date range, product count, document count, last-updated timestamp) and a per-document status (indexed / pending / failed), so it's obvious what state the system is in before testing or demoing.
- This is what makes the system testable end-to-end: swap in a different store's data or a new policy document, then immediately ask the agent about it, without redeploying anything.

## 6. Non-Functional Requirements

| Requirement      | Target                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Answer grounding | Every factual claim in a RAG answer must be traceable to a cited source                      |
| Response latency | Chat responses under ~5s for a single tool-call round trip                                   |
| Action safety    | No agent action executes without passing the guardrail check                                 |
| Auditability     | 100% of tool calls and actions logged with timestamp and reasoning                           |
| Cost control     | Demo runs on free/low-cost tiers (managed Postgres, small embedding model, capped API calls) |

## 7. Technology Stack Summary

| Layer                          | Technology                                                                                                                                   | Why                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend                       | Next.js 14+ (App Router), TypeScript                                                                                                         | Matches the stack signal from the target company; server components for the dashboard, streaming for chat, file upload for the data page                                                                                                                               |
| Orchestration                  | TypeScript API routes implementing a manual MCP-client tool-call loop against an OpenRouter chat completion                                  | OpenRouter's API is OpenAI-compatible and model-agnostic, but (unlike Anthropic's Messages API) has no built-in MCP connector, so the loop — discover tools, call the model, execute any requested tool via MCP, feed the result back — is handled in application code |
| LLM (via OpenRouter)           | Free-tier models on OpenRouter — e.g. Nemotron, DeepSeek, GPT-OSS — swappable via config or a UI dropdown, not hardcoded to one provider     | Model-agnostic by design; lets the demo show the same agent running on multiple open models, which doubles as a "no vendor lock-in" talking point                                                                                                                      |
| Agent tools / MCP server       | Python, official MCP SDK                                                                                                                     | Owns data access and tool logic; exposes `check_stock`, `sales_trend`, `flag_reorder`, `search_policies`, `notify_channel` as MCP tools over HTTP/SSE                                                                                                                  |
| Data processing & file parsing | Python — pandas/openpyxl for uploaded spreadsheets, pdfplumber (or similar) for uploaded PDFs, a chunking + embedding pipeline for documents | Matches the "Python for data processing" signal from your contact; now driven by uploads instead of a one-time load script                                                                                                                                             |
| Structured data store          | PostgreSQL                                                                                                                                   | Products, orders, derived stock, action log, Telegram messages                                                                                                                                                                                                         |
| Vector store                   | pgvector extension on the same Postgres instance                                                                                             | One datastore instead of a second vector DB service — simpler ops, "your stack, no sprawl"                                                                                                                                                                             |
| Embeddings                     | A small hosted embedding model                                                                                                               | Cheap and fast enough for a few thousand document chunks                                                                                                                                                                                                               |
| External notification          | Telegram Bot API                                                                                                                             | Real external system the agent acts on; visible to interviewers; inline approval buttons map to governance workflow                                                                                                                                                    |

**Buzzwords this project genuinely earns, not just name-drops:** Retrieval-Augmented Generation, Agentic AI (plan-then-act, not just respond), Model Context Protocol, tool use / function calling, hybrid search, grounded generation with citations, human-in-the-loop governance, structured + unstructured data fusion, model-agnostic LLM routing, external system integration.

## 8. Roadmap & Milestones

| Week | Milestone                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Load Online Retail II into Postgres as the default seed data; derive a stock view; write/generate default policy documents                                               |
| 1–2  | Build the spreadsheet + PDF parsing pipeline and the `/data` upload page; wire it to the same ingestion/embedding logic so uploads and the seed data go through one path |
| 2    | Build the MCP server (Python) with `search_policies`, `check_stock`, `sales_trend`, `notify_channel`                                                                     |
| 2–3  | Wire the orchestration layer: OpenRouter chat completion calls plus a manual MCP tool-call loop; ship basic chat UI with a model-selector dropdown                       |
| 3    | Add `flag_reorder`, guardrail/approval logic, action log, Telegram notification integration                                                                              |
| 3–4  | Build the proactive scheduled review flow; test tool-calling reliability across the candidate OpenRouter models and lock in a default                                    |
| 4    | Dashboard polish (low-stock panel, action log view, Telegram notifications panel); write demo script; (stretch) ticket clustering                                        |

## 9. Success Metrics / Demo Criteria

For the interview demo specifically, the project should be able to show, live:

1. A grounded, cited answer to a policy question.
2. A stock/sales question answered via a live MCP tool call.
3. The proactive review flagging a real reorder on its own, with visible reasoning.
4. One action being blocked by the approval guardrail, then approved by a human.
5. The action log showing a full audit trail of everything the agent did.
6. Uploading a new policy document live and immediately asking the agent a question that only that new document can answer.
7. Switching the active model between two OpenRouter options (e.g. DeepSeek and GPT-OSS) and re-asking the same question, to show the agent layer isn't tied to one provider.
8. A `flag_reorder` action triggering a Telegram notification with inline Approve/Reject buttons; clicking Approve in Telegram (or the dashboard) updates the action status in both places.

## 10. Risks & Assumptions

- **Assumption:** "Current stock" is derived from the transaction dataset (a starting quantity minus cumulative sales), since the dataset has no live inventory field. This is stated explicitly, not hidden.
- **Risk:** Retrieval quality on a small, self-authored document set may not stress-test the RAG layer meaningfully. Mitigate by including a few deliberately overlapping or ambiguous policy statements to test citation precision.
- **Risk:** Scope creep. Mitigate by treating everything past section 5.6 as optional and cutting it first if time runs short.
- **Risk:** Free-tier OpenRouter models vary in how reliably they follow structured tool-calling format — a model that reasons well can still fail to emit a valid tool call. Mitigate by testing each candidate model against the actual MCP tool set before the demo and keeping one proven-reliable model as the default, with others available to switch to live.
- **Risk:** Free-tier model endpoints on OpenRouter can have tighter rate limits or be temporarily unavailable. Mitigate by having a second free model configured as a fallback.
- **Risk:** Telegram API rate limits or temporary unavailability. Mitigate by logging the intended notification locally and providing a fallback in-app alert; the demo can still show the notification payload even if delivery fails.

## 11. Interview Talking Points

- Maps directly to two of the target company's own published case studies: a real-time support co-pilot, and a proactive-governance risk system.
- Demonstrates the full agent lifecycle — retrieval, tool use, autonomous planning, guardrail, audit — not just a Q&A bot.
- Deliberately scoped down rather than feature-padded, reflecting a "weeks not quarters" delivery discipline.
- **Agent acts on an external system of record (Telegram)** — not just internal DB rows — mapping directly to the "plan, act, and learn across your systems of record" language.
- **Governance is visible and interactive** — interviewers can click Approve/Reject in Telegram and see the DB update in real time.
- **Model-agnostic by design** — the same agent runs on multiple free-tier OpenRouter models, demonstrating "no vendor lock-in."
