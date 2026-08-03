# ShopIQ — Technical Design Document

**Version:** 1.0
**Author:** Benak Kishan J
**Companion to:** ShopIQ PRD v1.0
**Last updated:** August 2026

---

## 1. System Architecture Overview

Two data flows feed into one agent, which serves two kinds of interaction: a human asking questions, and a scheduled job asking the agent to plan on its own. Data enters the system two ways too — a default seed dataset, and live uploads through the frontend — so the system is testable without touching code.

```
        ┌────────────────────┐        ┌───────────────────────┐
        │  /data upload UI     │        │   Default seed data     │
        │ sales CSV/XLSX ·      │        │ (Online Retail II ·     │
        │ policy PDFs/DOCX/TXT  │        │  starter policy docs)   │
        └──────────┬──────────┘        └───────────┬───────────┘
                   │ multipart upload                │
                   └───────────────┬─────────────────┘
                                   ▼
                     ┌─────────────────────────────┐
                     │    Python ingestion service    │
                     │  parse (pandas/openpyxl,        │
                     │  pdfplumber) → chunk → embed →  │
                     │  upsert                          │
                     └───────────────┬─────────────┘
                                     │
┌────────────────────┐   ┌──────────▼──────────┐   ┌────────────────────┐
│ Products / Orders /   │──▶│   PostgreSQL          │◀──│  Derived stock view  │
│ OrderItems             │   │   + pgvector           │   │ (sold vs. initial)   │
└────────────────────┘   └──────────┬──────────┘   └────────────────────┘
                                     │
                           ┌─────────▼─────────┐
                           │    MCP server         │
                           │    (Python)            │
                           │  search_policies       │
                           │  check_stock           │
                           │  sales_trend           │
                           │  flag_reorder          │
                           └─────────┬─────────┘
                                     │  MCP (HTTP/SSE)
                           ┌─────────▼─────────┐
        user chat ────────▶│  Orchestration layer  │◀──── scheduled review job
                           │  OpenRouter chat        │      (no user prompt —
                           │  completion + a manual  │       agent plans on
                           │  MCP tool-call loop      │       its own)
                           └─────────┬─────────┘
                                     │
                           ┌─────────▼─────────┐
                           │ Next.js/TS frontend  │
                           │ chat · dashboard ·    │
                           │ data upload · log      │
                           └───────────────────┘
```

Three things distinguish this from a plain RAG chatbot: the **upload path**, which makes the whole system's state swappable for testing without redeploying; the **scheduled review job**, which invokes the same agent with no human turn and lets it decide what needs attention; and the **guardrail step** inside `flag_reorder`, which can pause an action for human approval before it takes effect.

## 2. Data Model

```sql
-- Structured retail data (seeded from Online Retail II)
Products(product_id PK, sku, description, unit_price, initial_stock)
Orders(order_id PK, customer_id, order_date, country)
OrderItems(order_id FK, product_id FK, quantity, unit_price)

-- Derived (materialized view, refreshed on ingestion)
StockView(product_id FK, current_stock)   -- initial_stock - sum(quantity sold), floored at 0

-- Unstructured documents (for RAG)
PolicyDocuments(doc_id PK, title, source_type, raw_text)
DocumentChunks(chunk_id PK, doc_id FK, content, embedding VECTOR, section_label, chunk_index)

-- Agent governance
ActionLog(action_id PK, action_type, tool_name, arguments JSONB, result JSONB,
          reasoning TEXT, status ENUM(pending_approval, approved, rejected, executed),
          created_at, resolved_at, resolved_by)
ReorderFlags(flag_id PK, product_id FK, suggested_quantity, reasoning, action_id FK, status)

-- Stretch (P2)
SupportTickets(ticket_id PK, text, embedding VECTOR, cluster_id)

-- Upload / ingestion tracking
IngestionRuns(run_id PK, source_type ENUM(sales_spreadsheet, policy_document),
               file_name, status ENUM(pending, processing, indexed, failed),
               row_count, chunk_count, error_message, uploaded_at, completed_at)
```

`ActionLog` is the single source of truth for "what did the agent do and why" — every MCP tool call gets a row, not just the ones that change state, so retrieval calls are auditable too.

## 3. Data Ingestion Pipeline

The pipeline runs the same way whether it's triggered by the default seed data at first boot or by a file dropped on the `/data` page — one code path, two triggers. Every run writes a row to `IngestionRuns` so the frontend has something concrete to show for "what's currently loaded."

**Structured — sales spreadsheet (Python, pandas/openpyxl):**

1. Accept a CSV or XLSX upload; validate it has the expected columns (invoice/order id, product/SKU, description, quantity, unit price, date) before touching the database — reject with a clear error otherwise.
2. Drop cancelled/negative-quantity rows and null customer IDs, matching the cleaning applied to the Online Retail II seed set.
3. Upsert into `Products`, `Orders`, `OrderItems`. A fresh upload can either replace the existing dataset or append to it — the `/data` page exposes this as an explicit choice, since silently merging two different stores' data would produce nonsense stock figures.
4. Assign each new product a stated `initial_stock` (default 500 units, overridable in the upload form) — this assumption is documented in the PRD, not hidden — and re-materialize `StockView` as `initial_stock - SUM(quantity sold)`, floored at zero.

**Unstructured — policy documents (Python):**

1. Accept PDF, DOCX, or TXT uploads (one or many at once). Extract text with `pdfplumber` for PDFs and `python-docx` for Word files; TXT/MD pass through directly.
2. Chunk with a recursive splitter that respects headings where present (~300–500 tokens per chunk, ~50-token overlap) so each chunk maps to a real, citable section.
3. Embed each chunk and store it in `DocumentChunks` alongside its `doc_id` and `section_label`. Re-uploading a document with the same title replaces its existing chunks rather than duplicating them.
4. The default seed set (15–20 self-authored policy documents) goes through this exact same path at first boot, so there's nothing document-specific hardcoded elsewhere in the system — swapping in a different store's real policies is just another upload.

## 4. RAG Design

- **Embedding model:** a small hosted embedding model — cheap and fast enough for a few thousand chunks; no need for anything larger at this scale.
- **Retrieval:** hybrid search — pgvector cosine-similarity top-k (k≈5) merged with a keyword/`ILIKE` pass for exact terms (SKU codes, policy names), then re-ranked. Pure vector search alone tends to miss exact-match terms like product codes.
- **Grounding check:** if the top retrieval score falls below a set threshold, the system responds "no relevant policy found" instead of answering from the model's parametric knowledge — this is what makes the "grounded" claim actually true rather than aspirational.
- **Citations:** the model is prompted to cite `[doc title § section]` inline; the frontend parses these into clickable citation chips linking back to the source chunk.

## 5. MCP Server Design

Built with the official MCP SDK in Python, exposed over HTTP/SSE so the Next.js orchestration layer can connect to it as a remote MCP server.

| Tool              | Input                                                                                     | Output                                                        | Side effect                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_policies` | `query: string, k?: number`                                                               | `{ chunks: [{doc_title, section, content, score}] }`          | None (read-only)                                                                                                                                         |
| `check_stock`     | `product: string`                                                                         | `{ product, current_stock, last_updated }`                    | None (read-only)                                                                                                                                         |
| `sales_trend`     | `product: string, period: string`                                                         | `{ product, period, units_sold, revenue }`                    | None (read-only)                                                                                                                                         |
| `flag_reorder`    | `product: string, quantity: number, reasoning: string`                                    | `{ flag_id, status }`                                         | Writes `ReorderFlags` + `ActionLog`; if `quantity × unit_cost` exceeds a configured threshold, status is `pending_approval` instead of executing         |
| `notify_channel`  | `chat_id: string, subject: string, body: string, action_id: string, approval_url: string` | `{status: "sent", message_id: string, approval_link: string}` | Sends a Telegram message with inline **Approve/Reject** buttons; writes a row to `TelegramMessages`; triggers approval workflow when buttons are clicked |

Every tool call — not just `flag_reorder` — writes a row to `ActionLog`. Approval itself is deliberately **not** an MCP tool: it's a human action taken through the dashboard UI, hitting a normal API route, not something the agent can grant itself.

## 6. Agent / Orchestration Design

**Why this layer looks different from a Claude-native build:** Anthropic's Messages API can connect to an MCP server directly via an `mcp_servers` parameter and executes the tool-call loop for you. OpenRouter doesn't have an equivalent — it exposes an OpenAI-compatible chat completions endpoint, and tool calling is just the standard `tools`/`tool_calls` format. That means the orchestration layer has to do the MCP-to-tool-calling bridging itself, which is genuinely more representative of how most teams have to wire agents together in practice.

**The bridge, concretely:**

1. On startup, the orchestration layer connects to the Python MCP server as an MCP client and calls `list_tools` to get each tool's name, description, and JSON Schema.
2. Each MCP tool definition is converted into an OpenAI-style function/tool definition and passed in the `tools` array of the OpenRouter chat completion request.
3. If the model's response includes one or more `tool_calls`, the orchestration layer executes each one against the MCP server, gets the result back, and appends it to the conversation as a `tool`-role message.
4. The completion request repeats with the updated conversation until the model returns a final answer with no further tool calls.
5. This loop is identical for both the reactive and proactive flows below — the only difference is what starts the conversation.

**Reactive loop (user-initiated):**
User message → Next.js API route → the MCP tool-call loop above, against the currently selected OpenRouter model → the final grounded response streams to the frontend with citations extracted from the tool results.

**Proactive loop (agent-initiated):**
A scheduled job — or, for a live interview demo, a manual "Run weekly review" button, since real cron jobs are awkward to demonstrate live — sends a system-authored instruction such as "review all products, cross-reference stock against sales trend, and flag any that need reordering," and runs the same tool-call loop with no human turn. The agent decides which products to check and which to flag. This loop, not the chat interface, is what actually demonstrates "plan and act" rather than "answer when asked."

**System prompt principles:**

- Always cite sources when answering from `search_policies`.
- Always state reasoning before calling `flag_reorder`.
- Never call `flag_reorder` on the same product more than once per review cycle.

**Guardrail middleware:** before a `flag_reorder` side effect is finalized, its cost impact is checked against a configurable threshold. Over the threshold, the row is written with `status = pending_approval` and nothing further happens until a human resolves it via the dashboard.

**Model selection (OpenRouter):**

- The active model is a config value — an environment variable by default, overridable per-conversation from a dropdown in the chat UI (e.g. `nvidia/nemotron-...:free`, `deepseek/deepseek-...:free`, `openai/gpt-oss-...:free`; check OpenRouter's current model catalog for exact free-tier slugs, since availability and naming shift over time).
- Not every free-tier model follows structured tool-calling reliably — a model can reason correctly but fail to emit a well-formed tool call. Before relying on any model for the demo, run it against the actual MCP tool set and confirm it calls tools correctly, not just that it answers plausibly.
- Keep one model that's been verified reliable as the default, and treat the dropdown as a way to _demonstrate_ model-agnosticism live, not as an untested feature — this is also a natural echo of the target company's own "your stack, no lock-in" pitch, worth saying out loud in the interview.

## 7. Frontend Design (Next.js / TypeScript)

**Pages**

- `/chat` — conversational interface, streamed responses, inline citation chips, and a model-selector dropdown for the active OpenRouter model.
- `/dashboard` — current stock table, pending-approval panel, "Run weekly review" trigger.
- `/data` — upload widgets for the sales spreadsheet and policy documents, a summary of what's currently loaded, and a per-file ingestion status list.
- `/log` — full action/audit log, filterable by status and date.

**Key components:** `ChatWindow`, `ModelSelector`, `CitationChip`, `StockTable`, `ApprovalCard`, `ActionLogTable`, `SpreadsheetUploader`, `DocumentUploader`, `DatasetSummaryCard`, `IngestionStatusList`.

## 8. API Contracts

| Method & Path                                                                              | Purpose                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `POST /api/chat` `{ message, conversation_id, model? }`                                    | Streams a grounded, tool-augmented response using the selected (or default) OpenRouter model   |
| `GET /api/stock`                                                                           | Returns current stock for all products                                                         |
| `GET /api/actions?status=pending_approval`                                                 | Returns actions awaiting human review                                                          |
| `POST /api/actions/:id/approve` `{ decision }`                                             | Approves or rejects a pending action; executes it if approved                                  |
| `POST /api/review/run`                                                                     | Manually triggers the proactive review flow (used for the live demo)                           |
| `POST /api/data/sales` (multipart, CSV/XLSX) `{ mode: replace \| append, initial_stock? }` | Uploads and ingests a sales spreadsheet; returns an `IngestionRuns` summary                    |
| `POST /api/data/policies` (multipart, one or more PDF/DOCX/TXT)                            | Uploads and ingests policy documents; returns per-file status                                  |
| `GET /api/data/summary`                                                                    | Returns current dataset stats: row/product counts, document count, last-updated timestamps     |
| `GET /api/models`                                                                          | Lists the configured OpenRouter models available in the selector, and which one is the default |

## 9. Deployment Architecture

- **Frontend:** Vercel (Next.js).
- **MCP server + Python pipeline:** a small container on Render or Railway, exposing MCP over HTTP/SSE.
- **Postgres + pgvector:** a managed Postgres instance with the pgvector extension (Supabase or Railway both support this) — one datastore for both structured and vector data.
- **Secrets:** the OpenRouter API key lives server-side only (Next.js API routes); it is never bundled into client code or exposed through the model-selector UI.

## 10. Security, Observability & Governance

- All LLM calls happen server-side — no API key ever reaches the browser.
- The chat endpoint is rate-limited to avoid runaway API spend during testing or demos, and to stay under free-tier OpenRouter rate limits.
- Uploaded files are validated before parsing: file type checked against an allowlist (CSV/XLSX for sales data, PDF/DOCX/TXT for policies), a size cap enforced, and spreadsheet parsing done in a way that doesn't execute macros or formulas — only reads cell values.
- Every MCP tool call is logged with its input, output, and latency — this is the project's observability story.
- The approval workflow in section 6 is the project's governance story, and the two together are what map most directly to the "guardrails and adoption" pitch this project is aimed at.

## 11. Evaluation & Testing Plan

- Hand-write 15–20 Q&A pairs against the policy documents; manually verify citation accuracy and check for a zero hallucination rate on out-of-scope questions.
- Seed a handful of products with deliberately low stock relative to recent sales, then confirm the proactive review flags them with sound, inspectable reasoning.
- Seed one action that should exceed the approval threshold and confirm it does not execute until a human approves it through the dashboard.
- Upload a malformed or incomplete spreadsheet (missing columns, empty file) and confirm the system rejects it with a clear error instead of corrupting the existing dataset.
- Run the same set of test questions against each candidate OpenRouter model (Nemotron, DeepSeek, GPT-OSS, etc.) and record which ones reliably emit correct tool calls versus which ones degrade to plain-text answers — this becomes the basis for picking the demo default.
