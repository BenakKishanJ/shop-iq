"""ShopIQ MCP server: exposes our store's data, policy + governance tools.

The agent loop (Day 5) and Claude Desktop connect here. Each @server.tool
decorator turns a Python function into an MCP tool: the function signature
becomes the inputSchema, the docstring becomes the description the LLM reads.

Day 6 governance: every tool call is recorded in action_log. Reorder flags
above APPROVAL_THRESHOLD are NOT executed — they sit as pending_approval until
a human approves via approve_action (or the API /api/actions/<id>/resolve).

Run (stdio transport, what clients spawn):
    python mcp_server.py
"""
import json
from mcp.server.fastmcp import FastMCP
from db import get_conn
from search_policies import search
from governance import (
    APPROVAL_THRESHOLD, log_action, resolve_action, send_telegram,
)

server = FastMCP("shopiq")


@server.tool(description=(
    "Semantic search over the store's policy documents (returns, refunds, "
    "pricing, privacy, supplier terms). Returns the top-k matching chunks "
    "with their document, section and similarity distance. Use when a "
    "question concerns store policy or procedures."))
def search_policies(query: str, k: int = 4) -> str:
    """Search store policies."""
    hits = search(query, k=k)
    if not hits:
        text = "No policy chunks found."
    else:
        text = "\n".join(
            f"[dist {h['distance']}] {h['title']} :: {h['section']}\n{h['content']}"
            for h in hits
        )
    conn = get_conn()
    try:
        log_action(conn, "search_policies", {"query": query, "k": k}, text)
        conn.commit()
    finally:
        conn.close()
    return text


@server.tool(description=(
    "Look up the current stock level, price and description for a product "
    "by its SKU. Use when asked about stock availability or inventory."))
def check_stock(sku: str) -> str:
    """Check current stock by SKU."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT sku, description, unit_price, current_stock "
                "FROM stock_view WHERE sku = %s",
                (sku,),
            )
            row = cur.fetchone()
            if not row:
                text = f"SKU {sku} not found."
            else:
                sku, desc, price, stock = row
                text = (f"{sku} | {desc}\n"
                        f"unit price: {price} | current stock: {stock}")
        log_action(conn, "check_stock", {"sku": sku}, text)
        conn.commit()
        return text
    finally:
        conn.close()


@server.tool(description=(
    "Daily units sold and revenue for a SKU over the trailing N days "
    "('today' = most recent order date in our data). Use to answer sales "
    "trend or performance questions."))
def sales_trend(sku: str, days: int = 30) -> str:
    """Sales trend for a SKU over the last N days."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT to_char(d.date, 'YYYY-MM-DD') AS day,
                          COALESCE(SUM(oi.quantity), 0) AS units,
                          COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS revenue
                   FROM (SELECT generate_series(
                               (SELECT MAX(order_date)::date FROM orders) - (%s - 1),
                               (SELECT MAX(order_date)::date FROM orders),
                               '1 day') AS date) d
                   LEFT JOIN orders o ON o.order_date::date = d.date
                   LEFT JOIN order_items oi ON oi.order_id = o.order_id
                   LEFT JOIN products p ON p.product_id = oi.product_id
                            AND p.sku = %s
                   GROUP BY d.date
                   ORDER BY d.date""",
                (days, sku),
            )
            rows = cur.fetchall()
            if not rows:
                text = f"SKU {sku} not found."
            else:
                total_units = sum(r[1] for r in rows)
                if total_units == 0:
                    text = f"{sku}: no sales in the last {days} days."
                else:
                    lines = [f"SKU {sku}: {total_units} units over last {days} days"]
                    lines += [f"  {day}: {units} units, {revenue:.2f}"
                              for day, units, revenue in rows if units]
                    text = "\n".join(lines)
        log_action(conn, "sales_trend", {"sku": sku, "days": days}, text)
        conn.commit()
        return text
    finally:
        conn.close()


@server.tool(description=(
    "List the top-N best-selling products by total units sold, including "
    "each one's current stock. Use to answer 'what is the top seller?' or "
    "'are we low on the best-selling product?' — the agent has no other way "
    "to discover which SKU is top-selling."))
def top_sellers(n: int = 5) -> str:
    """Top best-selling products."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT p.sku, p.description, sv.current_stock,
                          SUM(oi.quantity) AS sold
                   FROM order_items oi
                   JOIN products p USING (product_id)
                   JOIN stock_view sv USING (product_id)
                   GROUP BY p.sku, p.description, sv.current_stock
                   ORDER BY sold DESC
                   LIMIT %s""",
                (n,),
            )
            rows = cur.fetchall()
            if not rows:
                text = "No sales data found."
            else:
                text = "\n".join(
                    f"{sku} | {desc} | sold {sold} | current stock {stock}"
                    for sku, desc, stock, sold in rows
                )
        log_action(conn, "top_sellers", {"n": n}, text)
        conn.commit()
        return text
    finally:
        conn.close()


@server.tool(description=(
    "Search products by name (description) or SKU using partial matching. "
    "Returns matching SKUs, descriptions and current stock. Use when the "
    "user names a product but no SKU is known."))
def search_products(query: str, n: int = 5) -> str:
    """Search products by description or SKU."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            pattern = f"%{query}%"
            cur.execute(
                """SELECT sku, description, current_stock
                   FROM stock_view
                   WHERE sku ILIKE %s OR description ILIKE %s
                   ORDER BY description
                   LIMIT %s""",
                (pattern, pattern, n),
            )
            rows = cur.fetchall()
            if not rows:
                text = f"No products match {query!r}."
            else:
                text = "\n".join(
                    f"{sku} | {desc} | current stock {stock}"
                    for sku, desc, stock in rows
                )
        log_action(conn, "search_products", {"query": query, "n": n}, text)
        conn.commit()
        return text
    finally:
        conn.close()


@server.tool(description=(
    "Flag a product for restocking. Persists a reorder request for the "
    "given SKU with a suggested quantity and reasoning. Governance: the "
    "action is logged in the audit trail; quantities above the "
    "APPROVAL_THRESHOLD wait as pending_approval until a human approves. "
    "Use when the assistant decides stock is too low."))
def flag_reorder(sku: str, suggested_quantity: int, reasoning: str) -> str:
    """Flag a SKU for restocking."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT product_id FROM products WHERE sku = %s", (sku,))
            row = cur.fetchone()
            if not row:
                log_action(conn, "flag_reorder",
                           {"sku": sku, "suggested_quantity": suggested_quantity,
                            "reasoning": reasoning},
                           "SKU not found", action_type="action")
                conn.commit()
                return f"SKU {sku} not found."
            product_id = row[0]

        status = ("pending_approval"
                  if suggested_quantity > APPROVAL_THRESHOLD else "executed")
        action_id = log_action(conn, "flag_reorder",
                               {"sku": sku, "suggested_quantity": suggested_quantity,
                                "reasoning": reasoning},
                               f"suggest {suggested_quantity} units",
                               reasoning, status, action_type="action")
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO reorder_flags
                   (product_id, suggested_quantity, reasoning, action_id, status)
                   VALUES (%s, %s, %s, %s, %s) RETURNING flag_id""",
                (product_id, suggested_quantity, reasoning, action_id, status),
            )
            row = cur.fetchone()
            flag_id = int(row[0]) if row else 0
        conn.commit()
        if status == "pending_approval":
            return (f"Reorder flag #{flag_id} (action #{action_id}) created for "
                    f"{sku}: suggest {suggested_quantity} units ({reasoning}). "
                    f"AWAITS APPROVAL — over the {APPROVAL_THRESHOLD}-unit "
                    f"threshold.")
        return (f"Reorder flag #{flag_id} (action #{action_id}) created for "
                f"{sku}: suggest {suggested_quantity} units ({reasoning}). "
                f"Auto-approved within threshold.")
    finally:
        conn.close()


@server.tool(description=(
    "Send a message to the store operations channel (Telegram in production, "
    "stubbed as a persisted message now). Use to notify humans about "
    "reorder decisions, approvals or anomalies."))
def notify_channel(message: str, chat_id: str = "store-ops") -> str:
    """Notify the operations channel."""
    conn = get_conn()
    try:
        action_id = log_action(conn, "notify_channel",
                               {"message": message, "chat_id": chat_id},
                               message, action_type="action")
        text = send_telegram(conn, message, chat_id, action_id)
        conn.commit()
        return text
    finally:
        conn.close()


@server.tool(description=(
    "List recent actions from the governance audit trail. Optionally filter "
    "by status (executed | pending_approval | approved | rejected). Use to "
    "answer 'what has the agent done?' or to check on pending approvals."))
def list_actions(status: str = "all", limit: int = 20) -> str:
    """List governance actions."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            if status in ("pending_approval", "approved", "rejected", "executed"):
                cur.execute(
                    """SELECT action_id, tool_name, arguments, status,
                              created_at, resolved_by
                       FROM action_log
                       WHERE status = %s
                       ORDER BY action_id DESC LIMIT %s""",
                    (status, limit),
                )
            else:
                cur.execute(
                    """SELECT action_id, tool_name, arguments, status,
                              created_at, resolved_by
                       FROM action_log
                       ORDER BY action_id DESC LIMIT %s""",
                    (limit,),
                )
            rows = cur.fetchall()
        if not rows:
            text = "No actions logged yet."
        else:
            lines = []
            for action_id, tool, args, status, created_at, resolved_by in rows:
                a = json.dumps(args) if args else "{}"
                actor = resolved_by or "agent"
                lines.append(
                    f"#{action_id} [{status}] {tool}({a}) "
                    f"@ {created_at:%H:%M:%S} by {actor}")
            text = "\n".join(lines)
        return text
    finally:
        conn.close()


@server.tool(description=(
    "Approve or reject a pending governance action (e.g. a large reorder "
    "flag). Approving executes it; rejecting cancels it. The decision is "
    "recorded in the audit trail with who decided."))
def approve_action(action_id: int, approved: bool) -> str:
    """Approve or reject a pending action."""
    conn = get_conn()
    try:
        return resolve_action(conn, action_id, approved)
    finally:
        conn.close()


@server.tool(description=(
    "List the policy documents in the knowledge base (title, source type, "
    "chunk count, sections). Use to show what policies exist, or to confirm "
    "a newly added policy is searchable."))
def list_policies() -> str:
    """List policy documents."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT p.title, p.source_type, p.created_at::date,
                          COUNT(c.chunk_id) AS chunks,
                          string_agg(DISTINCT c.section_label, ', ') AS sections
                   FROM policy_documents p
                   LEFT JOIN document_chunks c ON c.doc_id = p.doc_id
                   GROUP BY p.doc_id, p.title, p.source_type, p.created_at
                   ORDER BY p.title""",
            )
            rows = cur.fetchall()
        if not rows:
            text = "No policy documents in the knowledge base."
        else:
            text = "\n".join(
                f"{title} [{source_type}] ({chunks} chunks)\n  sections: {sections}"
                for title, source_type, _created, chunks, sections in rows
            )
        return text
    finally:
        conn.close()


if __name__ == "__main__":
    server.run(transport="stdio")
