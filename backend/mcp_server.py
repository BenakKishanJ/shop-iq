"""ShopIQ MCP server: exposes our store's data + policy tools to any MCP client.

The agent loop (Day 5) and Claude Desktop connect here. Each @server.tool
decorator turns a Python function into an MCP tool: the function signature
becomes the inputSchema, the docstring becomes the description the LLM reads.

Run (stdio transport, what clients spawn):
    python mcp_server.py
"""
import json
import random
from mcp.server.fastmcp import FastMCP
from db import get_conn
from search_policies import search

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
        return "No policy chunks found."
    return "\n".join(
        f"[dist {h['distance']}] {h['title']} :: {h['section']}\n{h['content']}"
        for h in hits
    )


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
                return f"SKU {sku} not found."
            sku, desc, price, stock = row
            return (f"{sku} | {desc}\n"
                    f"unit price: {price} | current stock: {stock}")
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
                return f"SKU {sku} not found."
            total_units = sum(r[1] for r in rows)
            if total_units == 0:
                return f"{sku}: no sales in the last {days} days."
            lines = [f"SKU {sku}: {total_units} units over last {days} days"]
            lines += [f"  {day}: {units} units, {revenue:.2f}"
                      for day, units, revenue in rows if units]
            return "\n".join(lines)
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
                return "No sales data found."
            return "\n".join(
                f"{sku} | {desc} | sold {sold} | current stock {stock}"
                for sku, desc, stock, sold in rows
            )
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
                return f"No products match {query!r}."
            return "\n".join(
                f"{sku} | {desc} | current stock {stock}"
                for sku, desc, stock in rows
            )
    finally:
        conn.close()


@server.tool(description=(
    "Flag a product for restocking. Persists a reorder request for the "
    "given SKU with a suggested quantity and reasoning. This is a "
    "governance action: it records who/what asked and can go to a human "
    "approval flow. Use when the assistant decides stock is too low."))
def flag_reorder(sku: str, suggested_quantity: int, reasoning: str) -> str:
    """Flag a SKU for restocking."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT product_id FROM products WHERE sku = %s", (sku,))
            row = cur.fetchone()
            if not row:
                return f"SKU {sku} not found."
            product_id = row[0]
            cur.execute(
                "INSERT INTO reorder_flags (product_id, suggested_quantity, reasoning) "
                "VALUES (%s, %s, %s) RETURNING flag_id",
                (product_id, suggested_quantity, reasoning),
            )
            row = cur.fetchone()
            flag_id = int(row[0]) if row else 0
            conn.commit()
            return (f"Reorder flag #{flag_id} created for {sku}: "
                    f"suggest {suggested_quantity} units ({reasoning}).")
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
        with conn.cursor() as cur:
            message_id = random.randint(10**15, 9 * 10**15)
            cur.execute(
                "INSERT INTO telegram_messages (message_id, chat_id, payload) "
                "VALUES (%s, %s, %s::jsonb)",
                (message_id, chat_id, json.dumps({"text": message})),
            )
            conn.commit()
            return (f"Message queued for {chat_id}: {message} "
                    f"(message_id {message_id}).")
    finally:
        conn.close()


if __name__ == "__main__":
    server.run(transport="stdio")
