# Day 6 — Governance, Audit Trail & Policy Self-Service

The agent can act — now it must be **accountable**. Day 6 adds the three
things that turn a raw agent loop into something a real store would trust:

1. **Audit-first logging** — every MCP tool call, read or write, lands in an
   `action_log` table. The trail *is* the ground truth of "what the agent did".
2. **Materiality thresholds + human sign-off** — reorder flags over 300 units
   are not executed automatically; they sit as `pending_approval` until a human
   approves or rejects. This is the classic **approval matrix** from financial
   controls (think SOX), applied to an AI agent.
3. **Policy self-service** — a store manager can add a new policy document
   straight from the UI; it is chunked, embedded and searchable in the same
   request, no code changes.

**Files:**
- Backend: `backend/governance.py` (new), `backend/mcp_server.py` (rewritten to
  10 tools, all audit-logged), `backend/ingest_policies.py` (new
  `parse_sections()`), `backend/main.py` (new REST endpoints), `backend/agent.py`
  (system prompt teaches the agent about approvals)
- Frontend: `frontend/src/components/shell.tsx` (tabbed shell),
  `frontend/src/components/policy-library.tsx`, `frontend/src/components/governance.tsx`,
  `frontend/src/lib/api.ts` (typed REST client), `chat.tsx` refactor
- **Depends on:** Day 5 agent loop + `/api/chat`, Day 4 MCP, Day 3 RAG

---

## 1. Why governance matters (the interview hook)

An LLM can only *emit text*. Once we give it tools that write to the database
(`flag_reorder`) and message humans (`notify_channel`), we have handed it real
power. Three risks show up immediately:

| Risk | Naive approach | Day 6 answer |
|---|---|---|
| **No traceability** — how do you know what it did? | `SELECT` the tables, hope | Every call logged in `action_log`, reads included |
| **Runaway actions** — a hallucinated 10,000-unit order | Execute blindly | Over `APPROVAL_THRESHOLD` → waits for a human |
| **Policy drift** — the KB is out of date | Code change + redeploy | Add a policy from the UI; searchable instantly |

The key idea: **trust is earned by verification, not by promise**. An agent you
can audit and override is one a business will deploy.

---

## 2. The approval matrix (a 10-line idea)

`governance.py`:

```python
APPROVAL_THRESHOLD = 300
```

`flag_reorder` branches on it (`mcp_server.py:211`):

```python
status = ("pending_approval"
          if suggested_quantity > APPROVAL_THRESHOLD else "executed")
```

That one `if` is a miniature **risk-control framework**:

| Quantity | Status | Blast radius | Who decides |
|---|---|---|---|
| `≤ 300` | `executed` | Low — normal restock | Agent, but logged |
| `> 300` | `pending_approval` | High — big cash outlay | Human (`approve_action` / `/resolve`) |

The threshold is a *constant* on purpose: it is the single knob a compliance
reviewer reads. In a real system this would come from config and would encode
tiered limits per category (food vs. electronics vs. frozen).

---

## 3. The audit trail — `action_log`

Schema (from the migrations):

```sql
action_log (
  action_id     serial PRIMARY KEY,
  action_type   text,           -- 'tool_call' | 'action'
  tool_name     text,           -- which tool ran
  arguments     jsonb,          -- what the model passed in
  result        jsonb,          -- what came back ({text: ...})
  reasoning     text,           -- the model's stated reason, if any
  status        text,           -- executed | pending_approval | approved | rejected
  created_at    timestamptz,
  resolved_at   timestamptz,    -- set when a human approves/rejects
  resolved_by   text            -- who decided ('store-manager')
)
```

`log_action()` (`governance.py:27`) is a single `INSERT ... RETURNING action_id`.
Notes worth being able to say out loud:

- **Arguments and results are `jsonb`**, not text — you can query the trail
  ("all flag_reorder calls with quantity > 300") and the columns are self-describing.
- **`reasoning` is stored separately** — this is the model's stated *why*, which
  is exactly what a reviewer wants to scrutinize. Day 5 already forced the model
  to state reasoning before `flag_reorder`; now that reasoning is persisted.
- **Reads are logged too.** `search_policies` etc. log with `action_type="tool_call"`
  (the default), writes with `action_type="action"`. Both matter: an auditor
  wants the full picture, and the *Governance* tab shows a complete timeline.

---

## 4. `mcp_server.py` — the 10-tool catalog

All ten tools now share one behavior: **they log before they return**. The
signature pattern (e.g. `notify_channel`, `mcp_server.py:244`):

```python
action_id = log_action(conn, "notify_channel", {...}, message, action_type="action")
text = send_telegram(conn, message, chat_id, action_id)
conn.commit()
return text
```

| Tool | Kind | Logs | Notes |
|---|---|---|---|
| `search_policies` | read | yes | Day 3 RAG surface |
| `check_stock` | read | yes | SKU lookup |
| `sales_trend` | read | yes | 30-day trend |
| `top_sellers` | read | yes | |
| `search_products` | read | yes | |
| `flag_reorder` | write | yes | **threshold branch** → `pending_approval` |
| `notify_channel` | write | yes | Telegram-or-stub via `send_telegram` |
| `list_actions` | read | yes | answers "what has the agent done?" |
| `approve_action` | write | yes | delegates to `resolve_action` |
| `list_policies` | read | yes | shows KB + chunk counts |

Two design choices to flag in an interview:

- `approve_action` is itself a *tool*, so the agent **can** resolve approvals —
  but the *system prompt* tells it to surface pending items to a human and use
  the tool to carry out the human's decision, not to decide on its own.
- `flag_reorder` logs **before** inserting the reorder flag, and the flag row
  stores `action_id` — so `reorder_flags.action_id` links the operational table
  to its audit row. One unbroken thread from "model said" → "logged" → "flagged".

---

## 5. `governance.py` — approve/reject + notify

`resolve_action()` (`governance.py:46`) is the human-in-the-loop core:

```python
SELECT tool_name FROM action_log WHERE action_id = %s   -- does it exist?
UPDATE action_log SET status=..., resolved_at=now(), resolved_by=... WHERE ...
UPDATE reorder_flags SET status = ... WHERE action_id = ...   -- cascade
```

Two rows move atomically: the audit row flips to `approved`/`rejected`, and the
linked reorder flag follows. **Rejecting a flag is a true cancel**, not just a
label change.

`send_telegram()` (`governance.py:68`) shows the **integration-fallback pattern**:

```python
if TELEGRAM_BOT_TOKEN set:
    POST https://api.telegram.org/bot<token>/sendMessage → real message_id
else:
    stub message_id = random.randint(10**15, 9*10**15) → telegram_messages row
```

The integration point is *identical* either way — same `_persist`, same return
shape ("Message sent to store-ops (message_id …)"). That means the demo works
with zero external credentials, and production is a one-line env flip.

---

## 6. REST surface — the UI's view of governance

`main.py`:

| Endpoint | Purpose |
|---|---|
| `GET  /api/health` | now reports all 10 tool names |
| `POST /api/chat` | Day 5 agent loop |
| `GET  /api/policies` | every doc + its sections (from `document_chunks`) |
| `POST /api/policies` | ingest a new policy (title + `## Heading` content) |
| `GET  /api/actions?limit=` | audit trail, newest first, joined to flags |
| `POST /api/actions/{id}/resolve` | `{approved, resolved_by}` → `resolve_action` |

`POST /api/policies` is the interesting one. Because embedding is a **blocking
HTTP call**, it runs in the threadpool executor (same lesson as Day 5's
event-loop bug — never block the async loop):

```python
result = await loop.run_in_executor(
    executor, lambda: _ingest_policy(req.title, req.content))
```

`_ingest_policy` reuses the Day 3 `upsert_document`, but feeds it
`parse_sections(content)` — the new chunker that turns:

```markdown
## Feedback Loop
Return reasons are reviewed weekly by the store manager.
```

into a `(section, body)` pair. The **same pipeline** the seed data used, so a
UI-added policy is indistinguishable from a curated one.

---

## 7. The UI — tabs for Chat, Policies, Governance

`shell.tsx` replaces the old single-view page:

- **Header**: logo, `Tabs` (Chat / Policies / Governance), a `10 tools · audited`
  badge, and a model `Select` that only shows on the Chat tab.
- **Chat tab** = the Day 5 `ChatView` (suggestions now include "What has the
  agent done today?").
- **Policies tab** (`policy-library.tsx`): every document as a card with its
  sections in a `<details>` disclosure, plus an "Add policy" form.
- **Governance tab** (`governance.tsx`): the audit trail as cards — status
  badge, tool name, arguments, reasoning, who/when. Pending rows get
  **Approve / Reject** buttons; a `pending` count badge sits in the header.

`api.ts` is the typed client: `getPolicies`, `addPolicy`, `getActions`,
`resolveAction`, base URL `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"`.
One file, four functions, mirrors the four REST endpoints 1:1.

**A UX bug worth remembering** (found during verification): the "Added … chunks
embedded" success message was originally rendered *inside* the form's
conditional block, so it vanished the moment the form closed. Fix: hoist the
message outside `{showForm && …}` so it survives the close.

---

## 8. Failure → fix log (Day 6)

| Failure | Symptom | Root cause | Fix |
|---|---|---|---|
| UI add button "did nothing" under automation | no POST in API log, form stayed open | `agent-browser click @ref` didn't dispatch on a backdrop-blurred button | Feature itself worked — verified via a JS `.click()` dispatch; not a code bug |
| Success message invisible | "Added …" never shown | `saveMsg` rendered inside the form's conditional | Hoisted message out of `{showForm && …}` |
| Quota (free tier) | `/api/chat` → `{"detail":"OpenRouter request failed after 3 retries (last status 429)"}` | 50 free completions/day cap | UI surfaces a clean 503 bubble; **embeddings unaffected** — dynamic policy add still works |

The last row is a nice engineering story: chat completions and embeddings are
**separate** rate limits, so the "add a policy" demo kept working while chat was
throttled.

---

## 9. Verified results (this session)

Backend (live, via `mcp_test_client.py` and curl):

```
flag_reorder("21212", 100, ...)          → "Reorder flag #7 (action #1) created …
                                            Auto-approved within threshold."
flag_reorder("85123A", 500, ...)         → "Reorder flag #8 (action #2) created …
                                            AWAITS APPROVAL — over the 300-unit threshold."
approve_action(2, True)                  → "Action 2 (flag_reorder) approved by store-manager."
POST /api/policies {"title": "Clearance and Markdown Rules", "## Markdown Stages\n…"}
                                         → {"doc_id": 7, "chunks": 2}
search_policies("markdown stages for clearance stock")
                                         → "[dist 0.2762] Clearance and Markdown Rules :: Markdown Stages"
GET /api/health                          → lists all 10 tools
pyright backend/                         → 0 errors
```

Frontend (agent-browser on :3000):

```
Policies tab      → all 7 seeded docs + dynamic "Clearance and Markdown Rules"
Governance tab    → trail rows: #4 search_policies executed, #3 notify_channel
                    executed, #2 flag_reorder approved (store-manager), #1 executed
Add policy form   → button disabled until title+content → fills → POST 200 →
                    "Added "X" — N chunks embedded" persists after form closes,
                    doc appears in the list
npm run build     → passes
```

---

## 10. Interview Q&A

**Q: How do you prevent an agent from taking runaway actions?**
**A:** A materiality threshold. `flag_reorder` over 300 units is never executed —
it's logged as `pending_approval` and the store manager must approve or reject
it via the Governance tab (or the `approve_action` tool). Small actions
auto-run, but everything is recorded, so nothing is invisible.

**Q: Why audit reads as well as writes?**
**A:** An auditor wants the whole story, not just mutations. Logging reads also
lets us answer "why did the agent think X?" by replaying exactly what context it
retrieved. `action_type` separates `tool_call` (reads) from `action` (writes).

**Q: How does approval stay trustworthy if the agent can call `approve_action` itself?**
**A:** Capability and policy are different layers. The model *can* call the tool;
the system prompt defines when it *should* — it surfaces pending items and
executes the human's decision, it doesn't self-approve. In production you'd add a
server-side rule: `approve_action` only when the request carries a manager token.

**Q: How would this scale to many stores?**
**A:** The threshold becomes tiered config (per category, per store). The audit
trail stays append-only and gets a partition key. Notifications fan out per
store channel. The shape — log everything, gate the material, let a human sign
off — is unchanged.

**Q: What breaks first in production?**
**A:** The stub Telegram path. It's a deliberate seam: today a `telegram_messages`
row, tomorrow a real bot token. The demo and the production path share the same
`send_telegram` contract, so the swap is invisible to the rest of the system.
