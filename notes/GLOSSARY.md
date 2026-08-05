# ShopIQ — Glossary

Cumulative dictionary. Append as new terms appear. Keep definitions one line.

## Day 1
- **LLM** (Large Language Model) — a neural net that predicts the next token given previous tokens.
- **Token** — the atomic unit an LLM reads/writes (≈3-4 chars of text, not whole words).
- **Next-token prediction** — the core mechanism: model outputs a probability over its vocabulary, samples one token, repeats.
- **Temperature** — sampling randomness knob. Low = deterministic (tool calls), high = creative.
- **Context window** — max tokens the model can see in one request (input + output). "Memory" is just re-sending history.
- **Hallucination** — confident, plausible-sounding but wrong output; the core LLM weakness RAG fixes.
- **System / User / Assistant / Tool roles** — message roles in a chat-completions conversation.
- **Container** — a running, isolated instance of a Docker image.
- **Image** — a frozen, read-only snapshot/recipe of an app + its runtime.
- **Registry** — central repo of images (e.g., Docker Hub).
- **Volume** — persistent storage that survives container deletion.
- **Port mapping** (`-p host:container`) — exposes a container port on the host machine.
- **Environment variable** (`-e`) — config injected into a container at runtime.
- **Dockerfile** — recipe file for building your own image (`FROM`, `RUN`, `COPY`, `CMD`).
- **Docker Compose** — YAML file declaring multi-container apps; one command runs them all.
- **RDBMS** — Relational Database Management System (Postgres, Oracle, MariaDB).
- **Schema** — a namespace for tables (Postgres default: `public`).
- **Primary key** — unique row identifier; `SERIAL`/`IDENTITY` auto-increments it.
- **Foreign key** — a column referencing another table's PK (enforces referential integrity).
- **Materialized view** — a query whose results are stored on disk; must be refreshed.
- **UPSERT** — `INSERT ... ON CONFLICT (col) DO UPDATE/NOTHING`; insert-or-update.
- **CTE** (`WITH`) — a named subquery; `WITH RECURSIVE` handles trees.
- **Window function** — computes over a set of related rows without collapsing them (`ROW_NUMBER() OVER (PARTITION BY ...)`).
- **EXPLAIN ANALYZE** — runs a query and shows its execution plan + real timings.
- **JSONB** — binary JSON type; queryable with `->`, `->>`, `@>`.
- **Enum** — a restricted set of string values (`CREATE TYPE ... AS ENUM`).
- **Index** — a data structure (B-tree etc.) speeding up lookups on a column.
- **Embedding** — a list of numbers (a vector) representing a text's meaning (Day 1/2).
- **Vector DB / vector index** — stores and searches embeddings by similarity (Day 1/2).
- **pgvector** — Postgres extension adding vector type + distance operators (Day 1/2).

## Day 2
- **Embedding model** — a model that outputs a fixed-size vector per text (ours: 2048-dim, hosted on OpenRouter).
- **Dimension** — length of a vector; your `vector(n)` column must match the model's output dim.
- **Cosine distance** (`<=>`) — angle-based distance; smaller = more similar. Standard for text RAG.
- **Grounding threshold** — max distance allowed for a "relevant" chunk; beyond it, refuse to answer.
- **HNSW / IVFFlat** — pgvector index types for fast ANN search; **both cap at 2000 dims**.
- **Exact / brute-force search** — scan all rows; fine at a few thousand chunks.
- **Normalize identifiers at the boundary** — coerce IDs to strings on ingest; spreadsheets mix int/str.
- **Materialized view** — stored query results, refreshed manually; our `stock_view`.
- **Chunking** — splitting documents into retrievable, citable pieces (ours: by section heading).
- **Rate-limit batching** — send many embedding texts per request to respect free-tier limits.

## Day 3
- **RAG** (Retrieval-Augmented Generation) — retrieve evidence, inject it into the prompt, generate a grounded answer.
- **Retrieval** — the search step: find the top-k chunks most similar to the question.
- **Context assembly** — packing retrieved chunks into the prompt as "available sources".
- **In-context learning** — steering the model with prompt content instead of retraining.
- **Grounded answer** — an answer whose claims trace to retrieved sources.
- **Grounding check** — refuse when the best chunk is beyond the distance threshold (hard, pre-LLM).
- **Citation prompting** — forcing `[doc title :: section]` after claims; makes answers verifiable.
- **Prompt engineering** — iterating on instructions from model feedback (e.g., citation format fix).
- **Retry with backoff** — on 429/5xx, sleep `2s → 4s → 8s` and retry; fail loud on non-transient errors.
- **Low temperature** — deterministic output; used for citations and (later) tool calls.

## Day 4
- **MCP** (Model Context Protocol) — open standard for AI clients to discover and call tool servers (the "USB-C of AI tools").
- **MCP server** — exposes tools (functions an AI can call) over a transport.
- **MCP client** — the AI application that connects, lists tools, and calls them.
- **Transport** — the wire: `stdio` (spawned subprocess, newline-delimited JSON-RPC) or `HTTP/SSE` (remote).
- **Tool** — `name` + `description` + `inputSchema` (JSON Schema); the only interface the LLM sees.
- **inputSchema** — auto-generated by FastMCP from Python type hints; params without defaults become `required`.
- **JSON-RPC 2.0** — the message format MCP runs on (`initialize`, `tools/list`, `tools/call`).
- **Handshake** — `initialize` → `notifications/initialized` → then the app methods.
- **content block** — tool results returned as `[{type:"text", text:…}]`; the AI reasons over text.
- **AI-driven API design** — writing tool *descriptions* the model reads, not code docs humans read.
- **FastMCP** — the high-level `mcp` SDK decorator API (`@server.tool`); pinned to `1.29.0`.

## Day 5
- **Tool calling** — the model replies with structured `tool_calls` (name + JSON args) instead of text; *your* code executes them.
- **ReAct / agent loop** — LLM calls tools, results feed back as messages, repeats until a final answer.
- **`tool_call_id`** — correlates a tool result message to the call that produced it.
- **Discovery tool** — a tool whose job is finding things (e.g. `top_sellers`, `search_products`) so the agent can resolve questions to IDs/SKUs.
- **Threadpool offload** — running blocking work in a `ThreadPoolExecutor` so it can't block an async event loop.
- **CORS** — browser rule for cross-origin requests; the UI (3000) → API (8000) needs an allow-list.
- **Free-tier daily quota** — hard per-day cap (OpenRouter: 50 free requests/day; credits raise it).
- **shadcn/ui** — copy-paste React components styled with Tailwind CSS variables.
- **Citation chip** — a parsed `[doc title :: section]` rendered as a clickable-looking badge.
- **Claude palette** — warm cream/stone neutrals (`#faf9f5`) with a single coral accent (`#d97757`); no blue cast.

## Future days
*(append as we learn)*
