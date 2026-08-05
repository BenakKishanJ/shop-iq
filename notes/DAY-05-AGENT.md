# Day 5 — The Agent Loop, API & Chat UI

The co-pilot comes alive: the LLM gains **tool calling**, we wire it to the MCP
tools in a reason–act loop, expose it as a FastAPI endpoint, and build a
monochrome shadcn chat UI on Next.js 16.

**Files:**
- Backend: `backend/llm.py` (extended), `backend/agent.py`, `backend/main.py`
- Frontend: `frontend/src/components/chat.tsx`, `frontend/src/lib/parse-citations.ts`,
  `frontend/src/app/globals.css` (monochrome theme)

---

## 1. Tool calling (the concept)

The model normally outputs text. **Tool calling** lets it output a structured
"request to run code":

```json
"tool_calls": [{
  "id": "call_xyz",
  "type": "function",
  "function": {
    "name": "check_stock",
    "arguments": "{\"sku\": \"21212\"}"
  }}]
```

Critical points:
- The model **does not execute** anything — it announces intent. *Your code*
  runs the tool and sends the result back.
- `tools` is sent in the request (same name/description/JSON-schema shape as
  the MCP catalog). The model decides *if and how* to call them.
- **Arguments arrive as a JSON string** — you `json.loads` them before running.
- **Low temperature** is essential: the model must emit valid JSON in
  `arguments`, and follow the tool descriptions faithfully.

We verified `openai/gpt-oss-20b:free` does this correctly before building:
`check_stock({"sku":"21212"})` — a real evaluation-before-reliance step.

---

## 2. The agent loop (memorize this shape)

```
messages = [system, user question]
loop (max 5 iterations):
    reply = LLM(messages, tools=TOOLS)         # 1 LLM call
    if reply has no tool_calls:
        return reply.content                   # DONE
    append reply (assistant + tool_calls) to messages
    for each tool_call:
        result = MCP client call(name, args)   # execute via the wire
        append {"role":"tool", "tool_call_id", "content": result text}
```

Why it works: **the LLM is stateless** — every tool result is fed back as a new
message, so the model "remembers" what it did. This is the ReAct (Reason+Act)
pattern in its simplest form, and it's exactly the "memory = re-sending history"
idea from Day 1.

Why it terminates: `MAX_ITERATIONS = 5`. One final-answer turn is normal.

Why low temperature: tool calls must be deterministic (valid JSON, correct tool
selection).

---

## 3. `backend/agent.py` — the loop, line by line

```python
SYSTEM_PROMPT = """You are ShopIQ, the store operations co-pilot...
Rules:
- For stock or sales questions, call check_stock and/or sales_trend ...
- When the question names a "top seller" but no SKU, first call top_sellers ...
- When the user names a product by description, call search_products first ...
- For policy questions, call search_policies and answer ONLY from chunks,
  citing [doc title :: section] ...
- If a strong seller has very low stock and the user wants a fix, call
  flag_reorder ... then notify_channel ...
"""
```
The system prompt is the agent's *operating manual* — it encodes **when to use
each tool**, which is the AI-driven API design skill from Day 4 applied at the
agent level. Prompt rules we added iteratively after observing failures (below).

```python
def to_openai_tool(tool) -> dict:
    return {"type": "function",
            "function": {"name": tool.name,
                         "description": tool.description,
                         "parameters": tool.inputSchema}}
```
The MCP tool catalog is converted 1:1 to OpenAI's schema — `inputSchema` is
already JSON Schema, so this is a straight mapping.

```python
async with stdio_client(params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        catalog = await session.list_tools()      # LEARN the tools at runtime
        ...
        msg = llm.chat(messages, tools=tools_schema, model=model)
```
The agent **discovers its tools from the MCP server** (`tools/list`) — it never
hard-codes them. Same client pattern as `mcp_test_client.py` (Day 4). One MCP
session stays open for the whole question, so it's one subprocess per question,
not per tool call.

```python
tool_calls = msg.get("tool_calls") or []
if not tool_calls:
    return {"answer": msg.get("content") or "", "tool_uses": tool_uses}
messages.append({"role": "assistant", "content": msg.get("content"),
                 "tool_calls": tool_calls})       # assistant turn w/ intent
for call in tool_calls:
    fn = call["function"]
    args = json.loads(fn["arguments"] or "{}")
    result = await session.call_tool(fn["name"], args)
    text = "\n".join(b.text for b in result.content if getattr(b,"type","")=="text")
    messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
```
- Appending the full assistant message (with `tool_calls`) before the tool
  results is **required** by the API — that's how it knows which call the result
  belongs to (`tool_call_id`).
- `tool_uses` is recorded so the UI can show badges of what ran.

---

## 4. The two toolset gaps we hit (real agent-design lessons)

| Symptom | Root cause | Fix |
|---|---|---|
| "I need the SKU of the top seller" (no tool call) | no way to *discover* the top seller | added `top_sellers(n)` tool |
| "couldn't locate the white hanging heart t-light holder" | no way to resolve a *description* to a SKU | added `search_products(query, n)` tool |

Lesson: **an agent can only do what its tools let it do.** Before wiring the
LLM, design the tool set around the *questions users actually ask* — discovery
paths matter as much as the "answer" tools. The MCP server now exposes **7**
tools.

Verified chains:
- `top_sellers(1)` → `flag_reorder(...)` → final answer (top-seller stock at 0)
- `search_products(...)` → `top_sellers(5)` → `flag_reorder(...)` → `notify_channel(...)` → final answer (4-tool chain, description → SKU → action → notify)

Also observed: the agent flagged a reorder *proactively* when the user only
asked a question. That's the behaviour Day 6's governance/approval flow exists
to gate.

---

## 5. `backend/main.py` — the API (and the event-loop bug)

```python
executor = ThreadPoolExecutor(max_workers=4)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000"], ...)

@app.post("/api/chat")
async def chat(req: ChatRequest):
    result = await loop.run_in_executor(
        executor, lambda: asyncio.run(agent.run(req.question, model=req.model)))
    return {"answer": result["answer"], "tool_uses": result["tool_uses"]}
```

**The bug we hit and fixed:** the agent makes *synchronous* `requests.post`
calls inside async code. Running it on FastAPI's event loop meant one chat
request **blocked every other request** — `/api/health` froze mid-chat, and a
failed LLM call even crashed the whole server. Fixes:
1. **`run_in_executor` + `ThreadPoolExecutor`** → the blocking agent runs in a
   worker thread; the API stays responsive.
2. **try/except → clean `503` JSON** → a failed agent no longer kills uvicorn;
   the frontend gets a readable message.
3. **`_readable(exc)`** unwraps the MCP client's `ExceptionGroup` to the root
   cause (e.g. "OpenRouter request failed … 429").

**CORS:** the frontend (port 3000) → backend (port 8000) is cross-origin, so we
allow `http://localhost:3000`.

---

## 6. The free-tier quota (a production reality)

Mid-demo, every chat failed with `429`. The real error:
> `free-models-per-day` — "Add 10 credits to unlock 1000 free model requests
> per day" — X-RateLimit-Limit: 50, Remaining: 0

We burned OpenRouter's **free daily quota of 50 requests** in testing. `llm.py`
now retries with backoff and honours the `Retry-After` header, but a hard daily
cap can't be retried away. Reality check for the interview: free tiers cap you;
a demo account needs credits ($10 unlocks 1000 free/day) or a paid model.

---

## 7. The frontend — Next.js 16 + shadcn/ui, monochrome

**Stack:** `create-next-app` (TypeScript, App Router, Tailwind v4) + `shadcn`
(button, card, input, textarea, badge, scroll-area, separator, select,
skeleton, avatar). Built with `npx shadcn@latest init -d`.

**Design language:** the user specified **no colors** — whites/blacks/greys with
gradients. The shadcn default palette is already zinc-grey; we zeroed the two
non-grey tokens (`--destructive` red and the dark `--sidebar-primary` blue) to
achromatic `oklch` greys. Gradients come from inline `style` backgrounds
(`linear-gradient(...)` on the logo, wordmark, and hero title) — guaranteed to
render regardless of Tailwind version utilities.

**Components (all in `src/components/chat.tsx`):**
- **Header** — gradient wordmark, tagline, "7 tools · grounded" badge, and the
  **model selector** (`Select`, passed as `model` in the request body).
- **Empty state** — hero with gradient title, tagline, and 4 example prompt
  chips that pre-fill a question.
- **Message bubbles** — user: solid black, right-aligned; assistant: white card
  with an "S" avatar, plus:
  - **Tool badges**: a `⚙ check_stock` badge per tool actually used (from
    `tool_uses`) — makes agentic behaviour visible.
  - **Citation chips**: `parseCitations()` splits the answer on
    `[doc title :: section]` and renders each as a grey chip — the Day 3
    citations become clickable-looking UI.
- **Thinking state** — three animated pulsing dots (custom CSS keyframes in
  `globals.css`) while the agent works.
- **Input** — shadcn `Textarea` + send button; Enter sends, Shift+Enter newline.

**The parsing util (`parse-citations.ts`):** regex
`/\[([^\[\]]+?)\s*::\s*([^\[\]]+)\]/g` walks the text, producing a list of
`text`/`citation` segments. Pure function — easy to unit test.

---

## 8. How to run everything

```bash
# 1. backend (port 8000)
cd backend && ../.venv/bin/uvicorn main:app --port 8000
#    requires .venv with: pip install -r requirements.txt
# 2. frontend (port 3000)
cd frontend && npm run dev
# 3. open http://localhost:3000
```

Environment: `.env` needs `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
`EMBEDDING_MODEL`, `EMBEDDING_DIM`, `DATABASE_URL`. Postgres container must be
running (`docker start shopiq-db`). **Quota note:** free model daily limit
resets ~5:30 AM IST; credits unlock 1000 free/day.

---

## 9. Verified results (before the quota ran out)

```
$ python agent.py "are we low on the top-selling product?"
  tool calls: top_sellers({"n":1}) → flag_reorder({...})
  A: Yes – the top-seller (SKU 21212 ...) is out of stock (0 units).
     A reorder has been flagged for 500 units.

$ python agent.py "a customer opened an electronic item ... refund?"
  tool calls: search_policies({"k":4, ...})
  A: Opened electronics cannot be refunded once the packaging seal has been
     broken, unless the item is found defective.
     [Returns and Refunds Policy :: Opened Electronics]

$ curl POST /api/chat {"question":"how much stock does sku 21212 have?"}
  {"answer":"SKU 21212 ... has **0 units in stock**.",
   "tool_uses":[{"name":"check_stock","arguments":{"sku":"21212"}}]}
```

---

## 10. Interview Q&A

1. **How does your agent work?** A reason–act loop: the LLM gets its tool
   catalog from the MCP server, calls tools via the MCP client, and each result
   is fed back as a message until it writes a final answer — bounded by
   `max_iterations`.
2. **How do tool results get back to the model?** As `role: "tool"` messages
   with a matching `tool_call_id`; the assistant's `tool_calls` message is
   appended first. The "memory" is just the conversation history.
3. **Why did you add `top_sellers` and `search_products`?** The agent couldn't
   answer "are we low on the top seller?" or a product-by-description question —
   it had no discovery tool. Tools must cover the questions users ask.
4. **What did the event-loop bug teach you?** Blocking HTTP in an async server
   freezes the whole API. Offload to a threadpool (`run_in_executor`) and never
   let an agent failure kill the process.
5. **Why monochrome?** The user asked for a white/black/grey shadcn aesthetic —
   zeroed the chromatic tokens, gradients via inline styles.
6. **What about the 429s?** OpenRouter's free tier caps at 50 requests/day.
   We retry with backoff, but a daily cap is a hard limit — demo accounts need
   credits ($10 → 1000 free/day) or a paid model.
