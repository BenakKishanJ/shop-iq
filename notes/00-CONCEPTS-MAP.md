# ShopIQ — Concepts Map (Master Index)

Every concept, which day teaches it, where it lives in code, and which notes cover it. Use this to find anything fast before the interview.

## Legend
- **L:** where you learn it (conversation/lesson)
- **Code:** where it exists in the repo (added as we build)

> **Start here for the build story:** `IMPLEMENTATION-GUIDE.md` — tech stack, schema, module map, data flows, decision log, and how to reproduce everything.

---

## Day 1 — Foundations & Environment

| Concept | L | Notes | Code |
|---|---|---|---|
| LLMs are probability engines, not databases | ✅ | `DAY-01-foundations-llms.md` | — |
| Tokens, next-token prediction, temperature, context window | ✅ | `DAY-01-foundations-llms.md` | — |
| Chat completions API & message roles (system/user/assistant/tool) | ✅ | `DAY-01-foundations-llms.md` | `/api/chat` (Day 5) |
| Containers vs. VMs; images vs. containers | ✅ | `DOCKER.md` | `docker-compose.yml` |
| Docker run/pull/exec/ps/logs/volumes/Compose | ✅ | `DOCKER.md` | — |
| Postgres basics, psql meta-commands, SQL refresh | ✅ | `POSTGRES-SQL.md` | `schema.sql` |
| Materialized views (StockView pattern) | ✅ | `POSTGRES-SQL.md` | `stock_view` |
| UPSERT / ON CONFLICT (ingestion pattern) | ✅ | `POSTGRES-SQL.md` | ingestion pipeline (Day 2) |
| **Vector DBs**: embeddings, dimensions, cosine similarity, pgvector | ✅ | `VECTORS-PGVECTOR.md` | `document_chunks.embedding` (Day 2) |

## Day 2 — Embeddings, Seed Data & Ingestion
- Embedding models: generating vectors from text (hosted via OpenRouter, 2048-dim) → **`EMBEDDINGS-DEEP-DIVE.md`**
- Batching embeddings for free-tier rate limits | `backend/embeddings.py`
- Mixed-type identifiers bug; normalize at the boundary | `backend/load_sales.py`
- Online Retail II dataset load, cleaning, `StockView` refresh | `backend/load_sales.py`
- HNSW 2000-dim index limit; exact search tradeoff | `backend/schema.sql`
- Document chunking by section; embed + upsert replace | `backend/ingest_policies.py`
- Semantic search: `ORDER BY embedding <=> :vec` | `backend/search_policies.py`
- Real proof: zero-vocabulary-overlap query still retrieves the right policy
- Full DB/schema/vector storage+index+query reference → **`POSTGRES-SCHEMA-VECTORS.md`**
- Whole-system view (flows, patterns, how later days plug in) → **`ARCHITECTURE-OVERVIEW.md`**

## Day 3 — RAG
- Full RAG loop: embed → top-k → grounding check → context → cited answer → `**DAY-03-RAG.md**`
- In-context learning: pasting retrieved chunks into the prompt (no retraining) | `backend/rag_answer.py`
- Grounding: deterministic pre-LLM threshold (refuse when too far) + probabilistic post-LLM system prompt | `backend/rag_answer.py`
- Citation prompting `[doc title :: section]`; iterating on prompt to fix `[1]`-style citations | `backend/rag_answer.py`
- Retry-with-backoff on free-tier 429/5xx rate limits | `backend/llm.py`
- Chat completions client (`complete()`), low temperature for format adherence | `backend/llm.py`
- `search_policies` retrieval reused unmodified — thin wrapper architecture
- Threshold tuning against a labelled set of distances, not copied numbers

## Day 4 — MCP
- MCP = the USB-C of AI tools: one standard wire, any client ↔ any tool server → `**DAY-04-MCP.md**`
- Tool = name + description + JSON schema; the description is the docs the LLM reads | `backend/mcp_server.py`
- inputSchema auto-generated from Python type hints by `@server.tool` (FastMCP)
- Transports: stdio (local subprocess, newline JSON-RPC) vs HTTP/SSE (remote)
- Handshake: `initialize` → `notifications/initialized` → `tools/list` → `tools/call` | `backend/mcp_raw_client.py`
- Results come back as `content` text blocks (the AI reasons over text)
- The 5 tools: `search_policies`, `check_stock`, `sales_trend`, `flag_reorder`, `notify_channel`
- `sales_trend` anchored to `MAX(order_date)` — 2009-10 data, `now()` would return nothing
- SDK pin `mcp==1.29.0`: 2.0.0 reworked the API; verify import surface before coding
- Client harness = the pattern Day 5's agent loop uses | `backend/mcp_test_client.py`

## Day 5 — Agent Loop & Orchestration
- Tool calling: model emits `tool_calls` (name + JSON args), never executes | `backend/llm.py`
- Agent loop (ReAct): append assistant tool_calls → run via MCP client → feed `role:tool` results back → loop until text | `backend/agent.py`
- Agent discovers its tools at runtime via MCP `tools/list` (no hard-coding)
- Toolset gaps discovered: added `top_sellers`, `search_products` — an agent can only do what its tools let it do | `backend/mcp_server.py`
- FastAPI `/api/chat` + CORS; **threadpool offload** — blocking HTTP in async code freezes the API | `backend/main.py`
- Free-tier reality: OpenRouter caps at 50 free req/day; retries + `Retry-After`, but hard caps need credits
- Next.js 16 + shadcn/ui chat UI; monochrome (zero chromatic tokens, inline gradient styles) | `frontend/src/components/chat.tsx`
- Citation chips (`parseCitations` regex), tool-use badges, model selector, thinking dots
- Day 3 citations + Day 4 MCP tools now meet in one UI

## Day 6 — Governance
*(placeholder)*
- Guardrails & threshold approval; ActionLog; audit trail
- Dashboard & log views; Telegram notify + inline approve/reject

## Day 7 — Agentic Planning, Deployment & Interview
*(placeholder)*
- Proactive weekly review (agent plans without a prompt)
- Dockerize backend; deploy (Render/Railway); Vercel frontend
- Demo script; mock interview Q&A bank
