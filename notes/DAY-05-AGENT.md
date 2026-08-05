# Day 5 — Agent Loop, API & Chat UI (Deep Dive)

The co-pilot comes alive: the LLM gains **tool calling**, we wire it to the MCP
tools in a reason–act loop, expose it as a FastAPI endpoint, and build a
Claude-style chat UI on Next.js 16 + shadcn/ui.

**Files:**
- Backend: `backend/agent.py`, `backend/llm.py` (extended), `backend/main.py`,
  `backend/mcp_server.py` (two new tools)
- Frontend: `frontend/src/components/chat.tsx`, `frontend/src/lib/parse-citations.ts`,
  `frontend/src/app/globals.css` (Claude palette), `frontend/src/app/page.tsx`,
  `frontend/src/app/layout.tsx`
- **Depends on:** Day 4 MCP server + client pattern, Day 3 RAG, Days 1-2 data

---

## 1. Tool calling (the concept)

The model normally outputs text. **Tool calling** lets it instead output a
structured "request to run code":

```json
"tool_calls": [{
  "id": "call_xyz123",
  "type": "function",
  "function": {
    "name": "check_stock",
    "arguments": "{\"sku\": \"21212\"}"
  }}]
```

Critical points (interview-grade):
- The model **does not execute** anything — it announces *intent*. **Your code**
  runs the tool and sends the result back. The model is only ever a planner.
- `tools` is sent in the request, in the same name/description/JSON-schema
  shape as the MCP catalog. The model decides *if* and *how* to call them.
- **Arguments arrive as a JSON *string*** — you must `json.loads` them before
  running the tool. This is the #1 subtlety.
- **Low temperature** is essential: the model must emit valid JSON in
  `arguments` and pick tools faithfully. We use `temperature=0.2`.
- **Why tools at all?** The model has no live data — stock, sales, and policy
  live in Postgres. Tools are the bridge between *knowledge* (trained weights)
  and *ground truth* (the database).

We **verified `openai/gpt-oss-20b:free` does this correctly before building**:
a standalone test asked it to call `check_stock({"sku":"21212"})` and it emitted
a well-formed `tool_calls` block. Evaluation-before-reliance — don't build a
whole loop on an untested capability.

---

## 2. The agent loop (memorize this shape)

```
messages = [system, user question]
loop (max 5 iterations):
    reply = LLM(messages, tools=TOOLS)            # 1 LLM call
    if reply has no tool_calls:
        return reply.content                      # DONE
    append reply (role:"assistant" + tool_calls) to messages
    for each tool_call:
        result = MCP client call(name, args)      # execute via the wire
        append {"role":"tool", "tool_call_id": call.id,
                "content": result.text} to messages
```

Why it works: **the LLM is stateless** — every tool result is fed back as a new
message, so the model "remembers" what it did and can decide the next step. This
is the **ReAct (Reason + Act)** pattern in its simplest form, and it's exactly
the "memory = re-sending history" idea from Day 1.

Why it terminates: `MAX_ITERATIONS = 5`. A typical exchange is 1-3 LLM calls
(tool call → result → final answer). The cap is the safety valve against loops.

Why low temperature: tool calls must be deterministic — valid JSON, correct
tool selection. (Same reason we used low temperature for citations in Day 3.)

---

## 3. `backend/agent.py` — the loop, line by line

```python
import asyncio, json, os, sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent
import llm
```
- `stdio_client` / `ClientSession` — the same MCP client pattern from Day 4's
  `mcp_test_client.py`.
- `TextContent` — imported so we can *narrow* the content-block union
  (`isinstance(b, TextContent)`) instead of the string-hack
  `getattr(b, "type", "") == "text"`. Type-safe and what Pyright accepts.
- `import llm` — a sibling module; works because the process runs from
  `backend/` (uvicorn runs `main:app` from there, agent CLI is run from there).

```python
BACKEND = os.path.dirname(os.path.abspath(__file__))
MAX_ITERATIONS = 5
```
`BACKEND` lets the agent find `mcp_server.py` regardless of the current working
directory when it spawns the subprocess.

### The system prompt — the agent's operating manual

```python
SYSTEM_PROMPT = """You are ShopIQ, the store operations co-pilot...
Rules:
- For stock or sales questions, call check_stock and/or sales_trend ...
- When the question names a "top seller" but no SKU, first call top_sellers ...
- When the user names a product by description, call search_products first ...
- For policy questions, call search_policies and answer ONLY from the chunks,
  citing [doc title :: section] ...
- If a strong seller has very low stock and the user wants a fix, call
  flag_reorder ... then notify_channel ...
"""
```
This encodes **when to use each tool** — the AI-driven API-design skill from
Day 4 applied at the agent level. The rules are *not* the model's own invention:
we added each one *after watching a real failure* (see §9 failure log). Prompt
rules are the cheapest way to steer behaviour — iterate on them, don't retrain.

### `to_openai_tool` — the 1:1 schema bridge

```python
def to_openai_tool(tool) -> dict:
    return {"type": "function",
            "function": {"name": tool.name,
                         "description": tool.description,
                         "parameters": tool.inputSchema}}
```
MCP tool → OpenAI function schema. `tool.inputSchema` is *already* JSON Schema
(FastMCP generated it from Python type hints in Day 4), so this is a straight
field-by-field mapping — **one standard schema, two protocols** (MCP on the
wire, OpenAI tool-calling at the model). This is why "the MCP catalog" and
"the tools the LLM sees" are the same thing.

### `run()` — the whole loop

```python
params = StdioServerParameters(command=sys.executable,
    args=[os.path.join(BACKEND, "mcp_server.py")], cwd=BACKEND)
```
Spawn the MCP server as a subprocess (`sys.executable` = the same Python that's
running the agent). `cwd=BACKEND` so `mcp_server.py` can import `db` / `search_policies`.

```python
async with stdio_client(params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        catalog = await session.list_tools()
        tools_schema = [to_openai_tool(t) for t in catalog.tools]
```
The agent **discovers its tools at runtime** via `tools/list` — it never
hard-codes them. If we add an 8th tool tomorrow, the agent sees it with zero
code changes. One MCP session stays open for the *whole question*: one
subprocess per question, not one per tool call (which would be very slow).

```python
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": question},
        ]
        for _ in range(max_iterations):
            msg = llm.chat(messages, tools=tools_schema, model=model)
            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                return {"answer": msg.get("content") or "",
                        "tool_uses": tool_uses}
```
`llm.chat` returns the **full assistant message** (not just text) — that's what
Day 5 changed in `llm.py`. If the model chose to answer directly (no tool
calls), we're done. `tool_uses` accumulates what ran, so the UI can show badges.

```python
            assistant_msg = {"role": "assistant",
                             "content": msg.get("content"),
                             "tool_calls": tool_calls}
            messages.append(assistant_msg)
```
Appending the full assistant message (with its `tool_calls`) **before** the
results is *required by the OpenAI API* — it's how the server knows which tool
result belongs to which call. If you skip this, the API rejects the request.

```python
            for call in tool_calls:
                fn = call["function"]
                args = json.loads(fn["arguments"] or "{}")
                result = await session.call_tool(fn["name"], args)
                text = "\n".join(b.text for b in result.content
                                 if isinstance(b, TextContent))
                tool_uses.append({"name": fn["name"], "arguments": args})
                messages.append({"role": "tool",
                                 "tool_call_id": call["id"],
                                 "content": text})
```
- `json.loads(fn["arguments"] or "{}")` — arguments arrive as a JSON string.
- `session.call_tool` — actually executes the tool over the MCP wire
  (subprocess → `mcp_server.py` → SQL against Postgres).
- `tool_call_id` — the correlation key linking this result to the call.
- `tool_uses` — recorded for the UI's tool badges.

```python
    return {"answer": "No final answer produced.", "tool_uses": tool_uses}
```
Fallback if the iteration cap is hit without a final answer — the loop always
terminates, never hangs.

### `main()` — CLI entry

```python
q = sys.argv[1] if len(sys.argv) > 1 else "are we low on the top-selling product?"
result = asyncio.run(run(q))
```
Lets us test the agent without the API: `python agent.py "question here"`.

---

## 4. `backend/llm.py` — the chat() extension

Day 3's `complete()` sent text out. Day 5 adds `chat()`, which returns the
**full message object** — including `tool_calls` when the model wants tools.

```python
def chat(messages, tools=None, model=None, temperature=0.2, max_tokens=1024) -> dict:
    payload = {"model": model or CHAT_MODEL,
               "messages": messages,
               "temperature": temperature,
               "max_tokens": max_tokens}
    if tools:
        payload["tools"] = tools
    return _post(payload)["choices"][0]["message"]
```
- `tools` is only included when present — plain chat calls don't pay the schema
  overhead or invite spurious tool calls.
- `model` pass-through is what makes the frontend's **model selector** work
  (`agent.run(..., model=req.model)`).

```python
def _post(payload):
    for attempt in range(MAX_RETRIES):            # 3 attempts
        resp = requests.post(f"{BASE_URL}/chat/completions", headers=..., json=payload, timeout=90)
        if resp.status_code == 200: return resp.json()
        if resp.status_code in (429, 500, 502, 503):   # transient
            retry_after = resp.headers.get("Retry-After")
            wait = float(retry_after) if retry_after else RETRY_BACKOFF * (2 ** attempt)
            time.sleep(min(wait, 30))                  # cap so tests don't hang
            continue
        resp.raise_for_status()                       # anything else: fail loud
    raise RuntimeError(...)
```
- Honours the `Retry-After` header (OpenRouter sends it on 429), else
  exponential backoff capped at 30s.
- Only retries *transient* statuses. A 400 (bad request) is a bug in *our* code
  — fail loud so we notice.

---

## 5. `backend/main.py` — FastAPI + the event-loop bug

```python
app = FastAPI(title="ShopIQ API")
executor = ThreadPoolExecutor(max_workers=4)
app.add_middleware(CORSMiddleware,
    allow_origins=["http://localhost:3000"], allow_methods=["*"], allow_headers=["*"])

class ChatRequest(BaseModel):
    question: str
    model: str | None = None

@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "tools": ["check_stock", "sales_trend", "top_sellers",
            "search_products", "search_policies", "flag_reorder", "notify_channel"]}

@app.post("/api/chat")
async def chat(req: ChatRequest):
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: asyncio.run(agent.run(req.question, model=req.model)))
        return {"answer": result["answer"], "tool_uses": result["tool_uses"]}
    except Exception as exc:
        return JSONResponse(status_code=503, content={"detail": _readable(exc)})
```

**The bug we hit and fixed (interview gold):**
the agent makes *synchronous* `requests.post` calls to OpenRouter inside code
that FastAPI treats as async. If it runs on the event loop, one chat request
**blocks every other request** — `/api/health` froze mid-chat, and a failed LLM
call even crashed the whole uvicorn process. Fixes:

1. **`run_in_executor` + `ThreadPoolExecutor(4)`** — the blocking agent runs in a
   worker thread (`asyncio.run(agent.run(...))` inside the thread); the event
   loop stays free, so `/api/health` responds instantly even during a chat.
2. **try/except → clean `503` JSON** — a failed agent no longer kills the server;
   the frontend gets a readable `{"detail": "..."}`.
3. **`_readable(exc)`** — the MCP client re-raises errors wrapped in an
   `ExceptionGroup`. It unwraps recursively to the root cause:

```python
def _readable(exc: BaseException) -> str:
    if isinstance(exc, ExceptionGroup):
        return _readable(exc.exceptions[0])
    return str(exc)
```

**CORS:** the frontend (port 3000) → backend (port 8000) is cross-origin, so we
explicitly allow `http://localhost:3000`.

---

## 6. The MCP catalog the agent sees (7 tools)

From `tools/list`, converted 1:1 by `to_openai_tool`:

| Tool | Purpose | Signature |
|---|---|---|
| `search_policies` | semantic policy search (Day 3 RAG) | `query: str, k: int = 4` |
| `check_stock` | live stock/price/description | `sku: str` |
| `sales_trend` | units + revenue over N days | `sku: str, days: int = 30` |
| `top_sellers` | **Day 5 add** — rank by units sold | `n: int = 5` |
| `search_products` | **Day 5 add** — description→SKU lookup | `query: str, n: int = 5` |
| `flag_reorder` | persist a reorder request (governance) | `sku, suggested_quantity, reasoning` |
| `notify_channel` | message the ops channel (Telegram stub) | `message: str, chat_id = "store-ops"` |

The two Day 5 additions exist because the agent *stalled* without them (§9).

---

## 7. A real wire trace (agent → MCP server)

For `"how much stock does sku 21212 have?"` the LLM emitted:

```
client → server  tools/call  {"name": "check_stock", "arguments": {"sku": "21212"}}
server → client  {"content": [{"type": "text", "text": "21212 | PACK OF 72 RETRO SPOT
                              CAKE CASES\nunit price: 0.55 | current stock: 0"}],
                  "isError": false}
```

And for the 4-tool chain (`search_products → top_sellers → flag_reorder →
notify_channel`), the conversation grew message by message: each tool result was
appended as `{"role":"tool", "tool_call_id": <call id>, "content": <text>}`,
and the next LLM call chose the next step. **The agent's "state" is literally
the growing message list** — no hidden memory, no state machine.

---

## 8. End-to-end data flow (memorize this picture)

```
Browser (chat.tsx)                FastAPI (main.py)                 Agent loop (agent.py)
─────────────────                ─────────────────                 ─────────────────────
user types question   ──POST──▶  /api/chat (CORS ok)    ──run_in_executor──▶  spawns MCP server (stdio)
                                      ▲                                    │  initialize → tools/list
                                      │                                    │  llm.chat(messages, tools)
   ◀── renders answer ──◀── JSON ────┘                                    │  model emits tool_calls
   + tool badges                                                            │  session.call_tool(name, args)
   + citation chips                                                         │  MCP server runs SQL → text
                                                                             │  append role:tool result
                                                                             │  loop until final text
                                                                             └─▶ returns {answer, tool_uses}
```

Every hop is worth naming in an interview:
1. **Browser** → `fetch("http://localhost:8000/api/chat")` with `{question, model}`.
2. **FastAPI** validates via Pydantic, offloads to a thread so the event loop
   stays responsive.
3. **Agent** opens an MCP stdio session, discovers tools, runs the loop.
4. **MCP server** executes each tool against **Postgres** (stock_view, orders,
   policy vectors) and returns text.
5. **OpenRouter** supplies the model calls (text + `tool_calls`).
6. **Browser** renders the answer, tool-use badges (`⚙ check_stock`), and
   citation chips from `[doc :: section]`.

---

## 9. Failure → fix log (learned by watching it break)

| Symptom | Root cause | Fix |
|---|---|---|
| Agent answered "I need the SKU of the top seller" (no tool call) | no way to *discover* the top seller | added `top_sellers(n)` tool |
| Agent couldn't resolve "the white hanging heart t-light holder" | no way to map a *description* to a SKU | added `search_products(query, n)` tool |
| `/api/health` froze during a chat; uvicorn crashed on LLM failure | blocking sync HTTP in async code; unhandled exception | threadpool offload + try/except 503 + `_readable` ExceptionGroup unwrap |
| Every chat failed with `429` mid-demo | OpenRouter free-tier daily cap (50 req/day) | retries + `Retry-After` in `llm.py`; a *hard cap* can't be retried away → credits |
| Agent flagged a reorder when the user only asked a question | over-eager autonomous action | Day 6: governance / approval threshold |

Lesson (interview-grade): **an agent can only do what its tools let it do.** 
Before wiring the LLM, design the tool set around the questions users actually
ask — *discovery* paths (top_sellers, search_products) matter as much as the
"answer" tools. And **prompt rules** are the cheapest steering wheel: each one
in the SYSTEM_PROMPT exists because a real run went wrong without it.

---

## 10. Frontend — `chat.tsx` line by line

**Component inventory (all in one file):**

- **`MODELS`** — the model selector's options: `openai/gpt-oss-20b:free`,
  `openai/gpt-5-mini`, `anthropic/claude-sonnet-4`. The chosen value is sent as
  `model` in the request body and passed all the way through to `llm.chat()`.
  *This is the "pass-through" from §4 made visible to the user.*
- **`SUGGESTIONS`** — 4 empty-state prompt chips. Each is a *known-working*
  question that exercises a different path: top-seller discovery, policy RAG,
  description→SKU→reorder→notify (the 4-tool chain), and a sales trend.
- **`ToolUse` / `Message` types** — `Message` = `{role, content, toolUses}`.
  The frontend's message model mirrors the backend's `{answer, tool_uses}`.
- **`ToolRow`** — renders one `⚙ <name>` outline badge per tool the agent used.
  *This is what makes agentic behaviour visible*: the user sees the model call
  `check_stock`, not just get an answer.
- **`RichText`** — calls `parseCitations(content)` and renders text segments
  inline with `[doc :: section]` as **grey chips** (`title` attr = tooltip).
- **`Thinking`** — the three animated pulsing dots + "Consulting tools…" while
  the request is in flight. Pure CSS animation (`thinking-dot` keyframes).
- **`AssistantAvatar`** — rounded "S" avatar with a Bot icon.
- **`ThemeToggle`** — flips `theme` state; toggles the `.dark` class on
  `<html>` via `document.documentElement.classList.toggle("dark", ...)`.
  Persists to `localStorage`, defaults to dark.
- **`Chat` (main)** — state: `messages`, `input`, `loading`, `model`, `theme`.
  - `useLayoutEffect` applies the theme class *before* paint (no flash).
  - `useEffect` auto-scrolls to the latest message (`bottomRef.scrollIntoView`).
  - **`send(text)`**: trims, guards empties/re-entrancy (`if (loading) return`),
    appends the user bubble, then:
    ```ts
    const res = await fetch(`${API}/api/chat`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ question, model }),
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    setMessages(m => [...m, { role: "assistant",
                              content: data.answer, toolUses: data.tool_uses ?? [] }]);
    ```
    Errors render as an assistant bubble ("Something went wrong: …") instead of
    crashing — matching the backend's 503 JSON contract.
  - **Input**: `Textarea` + send `Button`. Enter sends, Shift+Enter is a newline
    (`onKeyDown` checks `!e.shiftKey`), send disabled while loading/empty,
    spinner icon while waiting.
- **`EmptyState`** — the hero: sparkles logo, headline, description, and the
  4 suggestion cards (hover lift + arrow). Shows only when `messages.length === 0`.

---

## 11. Frontend — `parse-citations.ts`

```ts
const CITATION_RE = /\[([^\[\]]+?)\s*::\s*([^\[\]]+)\]/g;

export function parseCitations(text: string): Segment[] {
  const segments = [];
  let last = 0;
  let match;
  while ((match = CITATION_RE.exec(text)) !== null) {
    if (match.index > last)
      segments.push({ type: "text", value: text.slice(last, match.index) });
    segments.push({ type: "citation",
                    citation: { doc: match[1].trim(), section: match[2].trim() } });
    last = match.index + match[0].length;
  }
  if (last < text.length)
    segments.push({ type: "text", value: text.slice(last) });
  return segments;
}
```
- Regex: `\[` literal bracket, `([^\[\]]+?)` lazy-captures the doc title, `::`,
  then `([^\[\]]+)` captures the section, `\]`. Global flag + `exec` in a while
  loop walks every citation.
- It keeps the *text between* citations as `text` segments and the citations as
  `citation` segments — a pure function (`text → Segment[]`), so it's trivially
  unit-testable. This is how the Day 3 `[doc title :: section]` convention
  becomes *clickable-looking chips* in the UI.

---

## 12. Frontend — `globals.css`: the Claude palette

The user asked for a clean, modern look "following Claude's design" — so the
theme is Claude's signature language:

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#faf9f5` (cream) | `#262624` | page |
| `--foreground` | `#262624` (warm near-black) | `#f0eee6` | text |
| `--card` | `#ffffff` | `#2e2d29` | bubbles/cards |
| `--muted` | `#f0ede6` | `#35332f` | secondary surfaces |
| `--muted-foreground` | `#6f6a60` | `#a8a298` | secondary text |
| `--border` | `#e6e2d6` | `#3f3d36` | hairline borders |
| **`--brand`** | **`#d97757` (coral)** | same | accent — Claude's orange |
| `--brand-strong` | `#c7684a` | `#e0815e` | hover accent |
| `--primary` | `#262624` | `#f0eee6` | user bubble / focus |

Design notes worth remembering:
- **Neutrals are warm, not grey** — `#faf9f5` has no blue cast; that's what
  makes it feel "Claude" rather than "GitHub". Almost all surface tokens are
  warm creams/stone greys.
- **One accent color** — coral `#d97757` is used *sparingly*: brand dot, focus
  ring, the send button, the empty-state logo, hover states. Restraint is what
  makes an accent feel designed.
- **Fluid type scale** (`--text-fluid-*`) — `clamp()`-based sizes that scale
  smoothly between viewport widths instead of jumping at breakpoints.
- **`html { font-family: var(--font-geist-mono) }`** — everything renders in
  Geist Mono (the project's chosen font), giving a technical, terminal-ish
  feel — fits a "store operations co-pilot".
- **Entrance animations** — `message-in` (fade + rise for bubbles) and
  `fade-up` (hero) use `cubic-bezier(0.16, 1, 0.3, 1)` (a common "ease-out
  quint" feel); `thinking-dot` uses staggered delays (`nth-child`) so the three
  dots pulse in sequence.
- **Theme switching** — CSS variables re-define under `.dark`; the `dark`
  class is toggled on `<html>`; `color-scheme` flips so native scrollbars /
  form controls match.

---

## 13. How to run everything

```bash
# 0. DB must be up (Day 2)
docker start shopiq-db

# 1. backend (port 8000)
cd backend && ../.venv/bin/uvicorn main:app --port 8000
#    (needs: pip install -r requirements.txt)

# 2. frontend (port 3000)
cd frontend && npm run dev

# 3. open http://localhost:3000
```

Environment: `.env` needs `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
`EMBEDDING_MODEL`, `EMBEDDING_DIM`, `DATABASE_URL`.
**Quota note:** the free model is capped at 50 requests/day (resets ~5:30 AM
IST); adding $10 credits unlocks 1000 free requests/day.

---

## 14. Verified results (before the quota ran out)

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

Verified 4-tool chain (the "order more" suggestion):
`search_products("white hanging heart t-light holder")` → `top_sellers(5)` →
`flag_reorder("85123A", 500, ...)` → `notify_channel(...)` → final answer.

---

## 15. Interview Q&A

1. **How does your agent work?** A ReAct-style reason–act loop. It discovers its
   tools from the MCP server via `tools/list`, asks the LLM to choose, executes
   chosen tools through the MCP client (each result fed back as a `role:tool`
   message), and repeats until it writes a final answer — bounded by
   `max_iterations=5`.
2. **How do tool results get back to the model?** As `role:"tool"` messages
   carrying a `tool_call_id`; the assistant's `tool_calls` message is appended
   first so the API can correlate them. The "memory" is just the conversation
   history — the model is stateless by design.
3. **Why did you add `top_sellers` and `search_products`?** The agent stalled on
   "are we low on the top seller?" and on product-by-description questions — it
   had no discovery tools. Tools must cover the questions users actually ask;
   discovery paths matter as much as answer tools.
4. **What did the event-loop bug teach you?** Blocking HTTP in an async server
   freezes the whole API. Offload blocking work to a threadpool
   (`run_in_executor`), never let an agent failure kill the process (try/except
   → clean 503), and unwrap MCP's `ExceptionGroup` to the root cause for
   readable errors.
5. **Why is the description of a tool so important?** It's the *only*
   documentation the model reads. A vague description means the agent never
   decides to call it. Writing tool descriptions for the model = AI-driven API
   design.
6. **Why one MCP session per question?** The server is a spawned subprocess;
   keeping the session open for the whole question means one subprocess, and
   tool calls reuse it instead of restarting a server per call.
7. **Why temperature 0.2?** Tool calls must be deterministic — valid JSON in
   `arguments`, correct tool selection. Low temperature suppresses hallucinated
   or malformed calls.
8. **What about the 429s?** OpenRouter's free tier caps at 50 requests/day.
   We retry transient failures with backoff and honor `Retry-After`, but a daily
   cap is a hard limit — demos need credits ($10 → 1000 free/day) or a paid
   model. This is a real production concern: rate limits shape what you can
   demo.
9. **What does the frontend show that the API returns?** `{answer, tool_uses}`.
   `tool_uses` drives the `⚙ tool` badges (visible agentic behaviour); the
   answer's `[doc :: section]` citations drive the chip rendering (verifiable
   claims). Both are the *observability* layer on top of the agent loop.
