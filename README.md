# ShopIQ

An agentic AI assistant for retail stores. ShopIQ understands your inventory,
your sales history, and your store policies, then answers questions in plain
language — and when something needs doing (like restocking a fast-moving item),
it proposes the action and routes it through a human approval trail.

> Screenshots are pending — each feature section links to a placeholder image
> under `docs/screenshots/`. Drop a screenshot there and update the path.

![ShopIQ chat tab](docs/screenshots/chat.png)

---

## What it does

ShopIQ combines three things a store assistant needs at the counter:

- **Real-time inventory & sales answers** — ask about stock levels, sales
  trends, top sellers, or whether a product exists, and get an answer grounded
  in your actual database.
- **Policy-aware retrieval (RAG)** — store policies (returns, pricing, safety,
  privacy) are embedded and searchable, so the agent answers *according to the
  rules* and cites the exact policy section it followed.
- **Governed actions** — when the agent decides to act (e.g. reorder a product
  that's low on stock), the action is logged and can be routed to a manager
  for approval before it's executed — an audit trail for every decision.

### Chat

The main tab. Ask anything in natural language:

- *"Are we low on the top-selling product?"*
- *"Can customers return opened electronics?"*
- *"We're out of the white hanging heart t-light holder, order more and tell
  the team."*

The agent streams its reasoning live, shows which tools it used, and quotes the
exact policy section when the answer comes from a document. You can switch the
underlying chat model and the embedding model used for policy search from the
header.

![Chat tab — ask questions and watch tool use stream in](docs/screenshots/chat.png)

### Policy Library

Browse every policy in the knowledge base, see how it's chunked into
searchable sections, and add new policies as plain text (headings like
`## Section name` become citable sections). New entries are embedded and
searchable immediately.

![Policy library tab — view and add policies](docs/screenshots/policies.png)

### Governance

A full audit trail of every action the agent has taken: which tool it called,
with what arguments, what result came back, and its reasoning. Pending actions
(like reorder suggestions) can be **approved** or **rejected** here, and every
decision is recorded with who resolved it and when.

![Governance tab — review and approve agent actions](docs/screenshots/governance.png)

---

## How it works

ShopIQ is an **agent loop**: a chat model observes a question, decides which
tools to call, reads their results, and repeats until it can answer. Tools are
exposed to the model through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

```
You  ──▶  FastAPI ──▶  Agent loop ──▶  MCP tools
                 ▲         │                ├── check_stock
                 │         │                ├── sales_trend / top_sellers
                 │         └────────────────├── search_products
                 │                          ├── search_policies   (RAG)
                 │                          ├── flag_reorder      (governance)
                 │                          ├── notify_channel    (Telegram)
                 ▼                          └── list/approve actions
          PostgreSQL + pgvector
      (sales, products, policies, action log)
```

- **Retrieval-Augmented Generation (RAG)** — store policies are chunked,
  embedded, and stored as vectors in `pgvector`. The `search_policies` tool
  does a similarity search, so answers cite the actual policy text.
- **Embedded Postgres** — the server ships with PostgreSQL + pgvector in one
  container, so the whole product runs with a single `docker run`. It also
  connects to external managed Postgres (Render, Neon) via `POSTGRES_HOST`.
- **SSE streaming** — `/api/chat` streams the agent run to the UI as
  server-sent events, surfacing thinking and tool calls live.

## Tech stack

| Layer      | Technology |
|------------|------------|
| Backend    | Python 3.14, FastAPI, uvicorn |
| Agent      | MCP (`mcp` SDK), threaded tool loop |
| LLM / Embeddings | OpenRouter (any Chat Completions / Embeddings endpoint) |
| Database   | PostgreSQL 17 + `pgvector` (embedded or managed) |
| Frontend   | Next.js (static export), React, Tailwind, shadcn/ui |
| Notifications | Telegram bot (optional) |

## Quick start

### One-command Docker (self-contained)

```bash
docker build -f backend/Dockerfile -t shopiq .
docker run -d --name shopiq \
  -p 8000:8000 \
  --env-file .env \
  -v shopiq-pg:/var/lib/postgresql/data \
  shopiq
```

Then open http://localhost:8000 — the container boots Postgres, applies the
schema, and seeds the policy library and the example retail dataset on first
run.

### Local development

```bash
# backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r ../requirements.txt        # repo-root requirements file
uvicorn main:app --reload --port 8000

# frontend (separate terminal)
cd frontend
npm install
npm run dev
```

For the frontend dev server to reach the API, set `NEXT_PUBLIC_API_URL` in
`frontend/.env.local` (see `frontend/.env.local` handling in the gitignore).

## Configuration

Copy `.env.example` to `.env` and fill in your values.

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | Key for the chat + embedding models |
| `OPENROUTER_BASE_URL` | OpenAI-compatible endpoint (OpenRouter by default) |
| `OPENROUTER_MODEL` | Default chat model |
| `EMBEDDING_MODEL` / `EMBEDDING_DIM` | Embedding model used for policy search |
| `POSTGRES_*` | Connection details (embedded defaults, or a managed DB) |
| `POSTGRES_SSLMODE` | Set `require` for managed hosts that mandate TLS |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional agent notifications |

> The policy index must be built (or re-built) with the same embedding model
> used for queries — switching models changes the vector dimensions and
> `search_policies` will tell you to re-ingest.

## Seeding data

- **Policies** — `python ingest_policies.py` (from `backend/`) embeds the seed
  documents; re-running replaces them.
- **Retail data** — `python load_sales.py data/raw/online_retail_II.xlsx`
  loads the example dataset (the xlsx stays out of git; see `data/raw/.gitkeep`).

Both scripts apply the schema automatically if the database is empty, so they
work against a brand-new managed Postgres too.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Service + tool roster |
| `GET /api/health/llm` | Live probe of the chat model |
| `GET /api/health/embeddings` | Live probe of the embedding model + index dimensions |
| `POST /api/chat` | Streaming agent run (SSE): `{question, model?, embed_model?}` |
| `GET/POST /api/policies` | List or add policy documents |
| `GET /api/actions` | Governance trail |
| `POST /api/actions/{id}/resolve` | Approve / reject an action |

## Deployment

The single image is deployable as-is on any container host:

- **Render** — web service (Docker), set the `PORT`-relative entrypoint (the
  container honors `$PORT`), and leave the frontend same-origin; the static
  build is served by the backend.
- **Managed Postgres (Neon / Supabase)** — set `POSTGRES_HOST` to the remote
  host; the entrypoint detects a non-local host and skips the embedded server,
  applying the schema and seeding remotely instead.

## License

MIT