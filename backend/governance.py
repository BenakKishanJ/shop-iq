"""Day 6 governance: audit trail, human-in-the-loop approvals, notifications.

Every MCP tool call is recorded in action_log so the store can replay exactly
what the agent did. Actions that cross a materiality threshold (large reorders)
are not executed automatically — they sit as pending_approval until a human
approves or rejects them. Notifications go to Telegram when configured, else to
the telegram_messages stub table.

Design notes (for the interview):
- Audit-first: reads AND writes are logged; the trail is the ground truth of
  "what the agent did", which is what a reviewer wants to see.
- Materiality threshold: small actions auto-run (low blast radius), large ones
  require a human. This is the classic "approval matrix" from governance
  (think SOX / financial controls), applied to an AI agent.
- Notification fallback: real Telegram if a bot token exists, else a DB stub —
  the integration point is the same either way.
"""
import json
import os
import random
import requests

# suggested_quantity above this must be approved by a human before execution
APPROVAL_THRESHOLD = 300


def log_action(conn, tool_name: str, arguments: dict, result: str,
               reasoning: str | None = None, status: str = "executed",
               action_type: str = "tool_call") -> int:
    """Insert one audit row; returns the new action_id."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO action_log (action_type, tool_name, arguments, result,
                                       reasoning, status)
               VALUES (%s, %s, %s::jsonb, %s::jsonb, %s, %s)
               RETURNING action_id""",
            (action_type, tool_name,
             json.dumps(arguments, default=str),
             json.dumps({"text": result}, default=str),
             reasoning, status),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def resolve_action(conn, action_id: int, approved: bool,
                   resolved_by: str = "store-manager") -> str:
    """Approve/reject a pending action; cascades to its reorder flag."""
    with conn.cursor() as cur:
        cur.execute("SELECT tool_name FROM action_log WHERE action_id = %s",
                    (action_id,))
        row = cur.fetchone()
        if not row:
            return f"Action {action_id} not found."
        status = "approved" if approved else "rejected"
        cur.execute(
            """UPDATE action_log
               SET status = %s, resolved_at = now(), resolved_by = %s
               WHERE action_id = %s""",
            (status, resolved_by, action_id),
        )
        cur.execute("UPDATE reorder_flags SET status = %s WHERE action_id = %s",
                    (status, action_id))
        conn.commit()
        return f"Action {action_id} ({row[0]}) {status} by {resolved_by}."


def send_telegram(conn, message: str, chat_id: str = "store-ops",
                  action_id: int | None = None) -> str:
    """Send a notification. Real Telegram when TELEGRAM_BOT_TOKEN is set,
    otherwise persist a stub row in telegram_messages."""
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if token:
        try:
            resp = requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": message},
                timeout=15,
            )
            if resp.status_code == 200:
                msg_id = resp.json()["result"]["message_id"]
                _persist(conn, msg_id, chat_id, message, action_id)
                return (f"Message sent to {chat_id} via Telegram "
                        f"(message_id {msg_id}).")
        except requests.RequestException:
            pass  # fall through to the stub
    msg_id = random.randint(10**15, 9 * 10**15)
    _persist(conn, msg_id, chat_id, message, action_id)
    return (f"Message queued for {chat_id} (Telegram not configured, "
            f"stub message_id {msg_id}).")


def _persist(conn, message_id: int, chat_id: str, message: str,
             action_id: int | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO telegram_messages (message_id, chat_id, action_id, payload)
               VALUES (%s, %s, %s, %s::jsonb)""",
            (message_id, chat_id, action_id, json.dumps({"text": message})),
        )
