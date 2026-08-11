"""Seed loader: Online Retail II -> Postgres.

One code path for sales data: parse -> clean -> upsert (products/orders/items)
-> refresh stock view. Later, /data uploads reuse this same logic.

Usage:
    python load_sales.py [path_to.xlsx]
"""
import sys
import pandas as pd
from db import apply_schema, get_conn

DEFAULT_SOURCE = "data/raw/online_retail_II.xlsx"
# Large enough that a stockout actually means the product sold out: the
# heaviest seller moves ~58k units, so 20k keeps the vast majority positive
# while still showing meaningful sell-through pressure on the top movers.
DEFAULT_INITIAL_STOCK = 20000

# These are accounting/adjustment entries, not real products
NON_PRODUCT_PREFIXES = ("ADJUST", "BANK CHARGES", "POSTAGE", "DOTCOM POSTAGE",
                        "M", "C2", "PADS", "AMAZONFEE", "CRUK", "gift_0001")


def clean_sales(df: pd.DataFrame) -> pd.DataFrame:
    """Validate + clean a sales dataframe. Returns a clean copy."""
    # 1. reject files missing the required columns
    required = {"Invoice", "StockCode", "Description", "Quantity",
                "InvoiceDate", "Price", "Customer ID"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")

    df = df.copy()
    # 2. drop cancelled/negative-quantity rows and unknown customers
    df = df.loc[(df["Quantity"] > 0) & df["Customer ID"].notna()]
    # 3. drop non-product accounting rows
    df = df.loc[~df["StockCode"].str.startswith(NON_PRODUCT_PREFIXES, na=False)]
    # 4. drop rows with no description
    df = df.loc[df["Description"].notna() & (df["Description"].str.strip() != "")]
    # 5. NORMALIZE IDENTIFIERS TO STRINGS — spreadsheets store numeric-looking IDs
    #    (e.g. 85048) as numbers and alphanumeric ones (79323P) as text. Mixed
    #    types make dict/join lookups silently fail. Normalize at the boundary.
    df["StockCode"] = df["StockCode"].astype(str).str.strip()
    df["Invoice"] = df["Invoice"].astype(str).str.strip()
    df["Customer ID"] = df["Customer ID"].astype(str).str.split(".").str[0]
    # 6. drop rows with unusable price
    df = df.loc[df["Price"].notna() & (df["Price"] > 0)]
    return df


def load(df: pd.DataFrame, initial_stock: int = DEFAULT_INITIAL_STOCK) -> dict:
    """Upsert cleaned sales data into Postgres and refresh the stock view."""
    conn = get_conn()
    apply_schema(conn)
    conn.commit()
    stats = {}
    try:
        with conn.transaction():
            # Products: one row per StockCode, with ON CONFLICT so re-runs merge
            products = (df.loc[:, ["StockCode", "Description", "Price"]]
                        .drop_duplicates(subset=["StockCode"]))
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO products (sku, description, unit_price, initial_stock)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (sku) DO UPDATE
                         SET description   = EXCLUDED.description,
                             unit_price    = EXCLUDED.unit_price,
                             initial_stock = EXCLUDED.initial_stock""",
                    [(r["StockCode"], r["Description"], float(r["Price"]),
                      initial_stock)
                     for r in products.to_dict("records")],
                )

            # Orders
            orders = (df.loc[:, ["Invoice", "Customer ID", "InvoiceDate", "Country"]]
                      .drop_duplicates(subset=["Invoice"]))
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO orders (order_id, customer_id, order_date, country)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (order_id) DO NOTHING""",
                    [(r["Invoice"], r["Customer ID"],
                      r["InvoiceDate"].to_pydatetime(), r["Country"])
                     for r in orders.to_dict("records")],
                )

            # OrderItems: need product_id, so look up sku -> product_id once
            with conn.cursor() as cur:
                cur.execute("SELECT sku, product_id FROM products")
                sku_to_id = dict(cur.fetchall())

            def to_items():
                for r in df.to_dict("records"):
                    pid = sku_to_id.get(r["StockCode"])
                    if pid is not None:
                        yield (r["Invoice"], pid, int(r["Quantity"]),
                               float(r["Price"]))

            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO order_items (order_id, product_id, quantity, unit_price)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (order_id, product_id) DO UPDATE
                         SET quantity = order_items.quantity + EXCLUDED.quantity""",
                    list(to_items()),
                )

            # Refresh the materialized stock view
            with conn.cursor() as cur:
                cur.execute("REFRESH MATERIALIZED VIEW stock_view")

        with conn.cursor() as cur:
            for q in ("SELECT COUNT(*) FROM products",
                      "SELECT COUNT(*) FROM orders",
                      "SELECT COUNT(*) FROM order_items"):
                cur.execute(q)
                row = cur.fetchone()
                stats[q.split("FROM ")[1].strip()] = int(row[0]) if row else 0
            cur.execute("SELECT COUNT(*) FROM stock_view WHERE current_stock = 0")
            row = cur.fetchone()
            stats["out_of_stock"] = int(row[0]) if row else 0
    finally:
        conn.close()
    return stats


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    print(f"reading {src} ...")
    raw = pd.read_excel(src)
    print(f"raw rows: {len(raw)}")
    clean = clean_sales(raw)
    print(f"clean rows: {len(clean)}  | products: {clean['StockCode'].nunique()}")
    stats = load(clean)
    print("loaded:", stats)
