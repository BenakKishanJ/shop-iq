"""MCP client harness: connects to mcp_server.py over stdio and exercises
every tool. This is the same client code the Day 5 agent loop uses.

Usage:
    python mcp_test_client.py
"""
import asyncio
import json
import os
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent

BACKEND = os.path.dirname(os.path.abspath(__file__))


async def main() -> None:
    params = StdioServerParameters(
        command=sys.executable,
        args=[os.path.join(BACKEND, "mcp_server.py")],
        cwd=BACKEND,
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print(f"tool catalog ({len(tools.tools)} tools):")
            for t in tools.tools:
                props = t.inputSchema.get("properties", {})
                print(f"  - {t.name}({', '.join(props)})")

            tests = [
                ("search_policies",
                 {"query": "can customers return opened electronics?", "k": 2}),
                ("check_stock", {"sku": "21212"}),
                ("sales_trend", {"sku": "21212", "days": 14}),
                ("flag_reorder",
                 {"sku": "21212", "suggested_quantity": 200,
                  "reasoning": "top seller, stock at zero"}),
                ("notify_channel",
                 {"message": "MCP test: reorder flag created", "chat_id": "store-ops"}),
            ]
            for name, args in tests:
                print(f"\n>>> tools/call {name} {json.dumps(args)}")
                res = await session.call_tool(name, args)
                for block in res.content:
                    if isinstance(block, TextContent):
                        print(block.text)


if __name__ == "__main__":
    asyncio.run(main())
