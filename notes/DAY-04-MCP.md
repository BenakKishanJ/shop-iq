# Day 4 — MCP (Model Context Protocol) Deep Dive

The USB-C of AI tools: one standard wire, and any AI client can discover and
call any tool server. This note walks all three files line by line, shows the
exact wire format, and records the SDK decision we had to make.

**Files:** `backend/mcp_server.py`, `backend/mcp_test_client.py`,
`backend/mcp_raw_client.py`
**Depends on:** Day 2 `search_policies.py`, Day 1 `db.py`, the Postgres schema

---

## 1. The problem MCP solves

Before MCP, every AI app needed a bespoke integration per tool. Your agent
wanted stock levels? You wrote a custom bridge. Claude wanted stock levels too?
Another custom bridge. Every socket needed its own bolt.

MCP standardizes the wire — **the same server works for our agent loop, Claude
Desktop, or any MCP client.** That's the interview point: in forward-deployed
AI consulting (IgniteIQ's business), the client already owns tools; MCP is how
an AI plugs in without a rewrite.

---

## 2. The three pieces

- **Server** — wraps your functions as *tools*, advertises them, executes calls.
- **Client** — the AI application: connects, lists tools, calls them.
- **Transport** — how bytes travel:
  - **stdio** — the client *spawns* the server subprocess and exchanges
    newline-delimited JSON-RPC over stdin/stdout. Zero network config, perfect
    for local dev and demos. **We use this.**
  - **HTTP/SSE** — remote server over HTTP with server-sent events; use when
    client and server are on different hosts (production, Claude Desktop remote).

---

## 3. A tool = name + description + JSON schema

The LLM never sees your code. It sees exactly this — the catalog we actually
served (from our `tools/list`):

```json
{
  "name": "check_stock",
  "description": "Look up the current stock level, price and description for a
                  product by its SKU. Use when asked about stock availability
                  or inventory.",
  "inputSchema": {
    "properties": { "sku": { "title": "Sku", "type": "string" } },
    "required": ["sku"],
    "type": "object"
  }
}
```

Two consequences:
1. **The description IS the documentation the model reads.** A vague one ("stock
   helper") means the agent never decides to call it. This is *AI-driven API
   design*: write descriptions that tell the model *when* and *how*.
2. **inputSchema is auto-generated** by FastMCP from your Python type hints.
   `def check_stock(sku: str)` → `{"sku": {"type": "string"}, "required": ["sku"]}`.
   A default like `k: int = 4` becomes `{"type": "integer", "default": 4}` and is
   *not* required. Your function signature IS the API contract.

---

## 4. The handshake (see it on the wire with `mcp_raw_client.py`)

```
client → server   initialize      {protocolVersion, capabilities, clientInfo}
server → client   initialize result {protocolVersion, capabilities, serverInfo}
client → server   notifications/initialized        (fire-and-forget, no reply)
client → server   tools/list                        ("what can you do?")
server → client   {tools: [{name, description, inputSchema}, ...]}
client → server   tools/call       {name, arguments}
server → client   {content: [{type: "text", text: "..."}], isError: false}
```

The actual transcript from our run:

```
--> initialize
<-- {"id":1, "result":{
       "protocolVersion":"2025-11-25",
       "capabilities":{... "tools": {...}},
       "serverInfo":{"name":"shopiq","version":"1.29.0"}}}

--> tools/list
<-- {"id":2, "result":{"tools":[{...5 tools, each with name/description/inputSchema...}]}}

--> tools/call {"name":"check_stock","arguments":{"sku":"21212"}}
<-- {"id":3, "result":{
       "content":[{"type":"text",
                   "text":"21212 | PACK OF 72 RETRO SPOT CAKE CASES\nunit price: 0.55 | current stock: 0"}],
       "isError":false}}
```

Two things to internalize:
1. **Results come back as `content` text blocks, not raw data.** The AI reasons
   over text — so every tool returns a formatted string, never a bare tuple.
2. **The catalog shows your descriptions verbatim.** What you write in the
   decorator is literally what the model reads. Proof in the wire.

---

## 5. Code walkthrough — `backend/mcp_server.py`

### Setup (lines 10–16)
```python
import json, random
from mcp.server.fastmcp import FastMCP
from db import get_conn
from search_policies import search

server = FastMCP("shopiq")
```
- `FastMCP("shopiq")` is the server object. The name becomes `serverInfo.name`.
- We import `search()` from Day 2 — **reuse, don't rewrite**. The MCP server is
  a thin wrapper over the code we already tested.

### Tool 1 — `search_policies` (lines 19–32)
```python
@server.tool(description="Semantic search over the store's policy documents ...")
def search_policies(query: str, k: int = 4) -> str:
    hits = search(query, k=k)
    if not hits: return "No policy chunks found."
    return "\n".join(f"[dist {h['distance']}] {h['title']} :: {h['section']}\n{h['content']}"
                     for h in hits)
```
- `@server.tool(description=...)` registers the function as an MCP tool.
- Returns a **formatted string** (text content block), not the raw hit list.
- The `description` says what it does *and* **when to use it** — that "when"
   clause is what lets the agent pick it.

### Tool 2 — `check_stock` (lines 35–55)
```python
with conn.cursor() as cur:
    cur.execute("SELECT sku, description, unit_price, current_stock FROM stock_view WHERE sku = %s", (sku,))
    row = cur.fetchone()
    if not row: return f"SKU {sku} not found."
    return f"{sku} | {desc}\nunit price: {price} | current stock: {stock}"
```
- `%s` placeholders + tuple params = **parameterized query** (SQL injection
  safe). Never f-string user input into SQL.
- The `finally: conn.close()` pattern (Day 2 discipline): connection always
  released, even on error.

### Tool 3 — `sales_trend` (lines 58–94) — the interesting SQL
```python
cur.execute("""
  SELECT to_char(d.date,'YYYY-MM-DD'), COALESCE(SUM(oi.quantity),0),
         COALESCE(SUM(oi.quantity*oi.unit_price),0)
  FROM (SELECT generate_series(
              (SELECT MAX(order_date)::date FROM orders) - (%s - 1),
              (SELECT MAX(order_date)::date FROM orders), '1 day') AS date) d
  LEFT JOIN orders o  ON o.order_date::date = d.date
  LEFT JOIN order_items oi ON oi.order_id = o.order_id
  LEFT JOIN products p ON p.product_id = oi.product_id AND p.sku = %s
  GROUP BY d.date ORDER BY d.date
""", (days, sku))
```
Three techniques:
- **`generate_series(start, stop, '1 day')`** builds a calendar of the last N
  days *including days with zero sales* — so "no sales on Tuesday" is visible,
  not silently missing.
- **`LEFT JOIN`** keeps every calendar day even when no order matches.
- **`COALESCE(SUM(...), 0)`** turns NULL (no rows for that day) into 0.
- **Anchor to `MAX(order_date)`**, not `now()` — see §8 for why.

### Tool 4 — `flag_reorder` (lines 97–122) — the governance hook
```python
cur.execute("SELECT product_id FROM products WHERE sku = %s", (sku,))
product_id = cur.fetchone()[0]
cur.execute("INSERT INTO reorder_flags (product_id, suggested_quantity, reasoning) VALUES (%s,%s,%s) RETURNING flag_id", ...)
conn.commit()
return f"Reorder flag #{flag_id} created for {sku}: suggest {suggested_quantity} units ({reasoning})."
```
- **Persists** the decision into the `reorder_flags` table — Day 6 turns this
  into the approval/audit flow. The MCP tool is the *write path* for agency.
- `RETURNING flag_id` gets the inserted row's ID in one round-trip.
- `conn.commit()` — explicit, so a later failure can't leave it half-saved.

### Tool 5 — `notify_channel` (lines 125–144) — the human loop stub
```python
message_id = random.randint(10**15, 9*10**15)
cur.execute("INSERT INTO telegram_messages (message_id, chat_id, payload) VALUES (%s,%s,%s::jsonb)",
            (message_id, chat_id, json.dumps({"text": message})))
```
- Persists a queued message; Day 6 swaps this for a real Telegram `sendMessage`.
- The schema's `message_id BIGINT PRIMARY KEY` has no default, so we generate
  one (a random 15-digit). A stub — Day 6 replaces it with Telegram's real ID.

### Entry point (lines 147–148)
```python
if __name__ == "__main__":
    server.run(transport="stdio")
```
Runs the server on stdio so a client can spawn it as a subprocess.

---

## 6. Code walkthrough — `backend/mcp_test_client.py` (the SDK client)

This is **the exact pattern Day 5's agent loop uses** — understand every line.

```python
params = StdioServerParameters(command=sys.executable,
                               args=[os.path.join(BACKEND, "mcp_server.py")],
                               cwd=BACKEND)
async with stdio_client(params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        ...
        res = await session.call_tool(name, args)
        for block in res.content: print(block.text)
```
- `StdioServerParameters` says **how to spawn the server**: which interpreter
  (`sys.executable` = the venv python), which file, which working directory
  (so `db`/`search_policies` imports resolve).
- `stdio_client(...)` launches it and gives us anyio byte streams.
- `ClientSession` is the protocol client; `initialize()` does the handshake.
- `list_tools()` → the catalog; `call_tool(name, args)` → a result whose
  `.content` holds the text blocks.
- This is an `async` context-manager world (anyio). Day 5's agent loop will be
  `async` for the same reason.

---

## 7. Code walkthrough — `backend/mcp_raw_client.py` (see the wire)

A hand-rolled client — **no SDK on the client side** — to prove we understand
the protocol. It writes JSON-RPC lines to the server's stdin and reads replies.

```python
def rpc(method, params):
    frame = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
    proc.stdin.write(json.dumps(frame) + "\n"); proc.stdin.flush()
    while True:                                   # keep reading until OUR id
        reply = json.loads(proc.stdout.readline())
        if reply.get("id") == msg_id: return
```
- Every request is one **newline-delimited JSON line** — that's the stdio framing.
- `id` correlates requests to responses; the loop skips any notifications until
  the matching id arrives.
- The initial `initialize` sends `LATEST_PROTOCOL_VERSION` imported from the
  SDK (`from mcp.shared.version import LATEST_PROTOCOL_VERSION`) — so we always
  speak the current protocol without hard-coding the date string.

Why does this exist? It talks to the **same FastMCP server** the SDK client
talks to — proving a from-scratch client interoperates with an SDK server.
That's the point of a *standard*.

---

## 8. Data quirk handled: anchoring "today"

Our orders span **2009-12-01 → 2010-12-09**. "Last 30 days from `now()`" would
return nothing — the data is 15 years old. So `sales_trend` anchors its window
to `MAX(order_date)`, and the tool description *tells the agent*:
> "'today' = most recent order date in our data"

Two lessons: (a) always check your data's actual date range before writing
time-based queries; (b) encode the assumption where the model can read it.

---

## 9. SDK decision: why we pinned `mcp==1.29.0`

The brand-new `mcp 2.0.0` (released this month) **reworked the whole API** —
`FastMCP` moved, the `mcp.server.fastmcp` import path is gone, decorator-style
tool registration replaced by a new `MCPServer` object. We checked the import
surface first (`dir()`), saw the breakage, and **pinned the stable 1.x line**
because:
- every tutorial, blog, and the design doc use `FastMCP`;
- it's what an interviewer expects when you say "MCP Python SDK";
- 2.0.0 is days old and unproven.

Lesson: **verify a package's API before building on assumptions.** A 10-second
`dir()` check beats an hour of debugging a moved import.

---

## 10. Verified results (live run)

```
tool catalog (5 tools): search_policies, check_stock, sales_trend,
                        flag_reorder, notify_channel

>>> check_stock 21212 → "21212 | PACK OF 72 RETRO SPOT CAKE CASES
                         unit price: 0.55 | current stock: 0"
>>> sales_trend 21212 14 → "SKU 21212: 250866 units over last 14 days
                            2010-11-29: 36535 units, 63371.48  ..."
>>> flag_reorder 21212  → "Reorder flag #1 created for 21212: suggest 200 units"
>>> notify_channel      → "Message queued for store-ops (message_id 2587555069538547)"
```

---

## 11. How Day 5 plugs in

The agent loop runs `llm.complete()` (Day 3) extended to send the `tools` array
(= the MCP catalog) and handle `tool_calls`. Each tool call is dispatched to the
MCP client (`mcp_test_client` pattern): spawn server, `call_tool`, feed the text
result back to the model. The loop repeats until the model answers without a
tool call.

---

## 12. Interview Q&A

1. **What is MCP?** An open standard (JSON-RPC 2.0 based) letting AI clients
   discover and call tools from any server — the USB-C of AI tools.
2. **Name the parts.** Server (exposes tools), client (consumes them), transport
   (stdio or HTTP/SSE), and the tool definition (name + description + JSON
   schema).
3. **What does an LLM actually see about a tool?** Only name, description,
   inputSchema. The description must explain *when* to use the tool.
4. **Why stdio?** Client spawns the server locally; newline-delimited JSON-RPC;
   no ports or auth. Perfect for a dev demo. HTTP/SSE is the production upgrade.
5. **Why pin mcp 1.29?** 2.0 reworked the API; the classic FastMCP API is what
   docs/interviewers expect. Verified the import surface before committing.
6. **How do tool results come back?** As `content: [{type: "text", text: …}]`
   blocks — text the model reasons over, not raw data.
