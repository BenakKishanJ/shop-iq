"""ShopIQ agent loop: LLM + MCP tools, reason-act loop.

The model discovers its tools from the MCP server (tools/list), calls them
via the MCP client, and sees results fed back until it writes a final answer.

Usage:
    python agent.py "are we low on the top seller?"
"""
import asyncio
import json
import os
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent
import llm

BACKEND = os.path.dirname(os.path.abspath(__file__))
MAX_ITERATIONS = 5

SYSTEM_PROMPT = """You are ShopIQ, the store operations co-pilot for a retail
company. You have tools to read live data and search store policies — use them
when they help; never guess numbers, policies, or SKUs from memory.

Rules:
- For stock or sales questions, call check_stock and/or sales_trend and report
  the real returned numbers.
- When the question names a "top seller" or "best-selling product" but no SKU,
  first call top_sellers to discover which SKU that is.
- When the user names a product by description (not a SKU), call search_products
  first to resolve it to a SKU.
- For policy questions, call search_policies and answer ONLY from the returned
  chunks, citing [doc title :: section] after each policy claim.
- If a strong seller has very low stock and the user wants a fix, call
  flag_reorder with a sensible suggested_quantity and a one-line reasoning,
  then notify_channel about the decision. If the flag says it AWAITS APPROVAL
  (over the threshold), say so clearly in your answer.
- When asked what the agent has done or about pending actions, call
  list_actions.
- If a tool result says the data is not found or not covered, say so honestly.
- Answer concisely and directly."""


def to_openai_tool(tool) -> dict:
    """Convert an MCP tool into OpenAI tool-calling schema."""
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.inputSchema,  # already JSON Schema
        },
    }


async def run(question: str, max_iterations: int = MAX_ITERATIONS,
              model: str | None = None) -> dict:
    params = StdioServerParameters(
        command=sys.executable,
        args=[os.path.join(BACKEND, "mcp_server.py")],
        cwd=BACKEND,
    )
    tool_uses = []
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            catalog = await session.list_tools()
            tools_schema = [to_openai_tool(t) for t in catalog.tools]

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

                assistant_msg = {
                    "role": "assistant",
                    "content": msg.get("content"),
                    "tool_calls": tool_calls,
                }
                messages.append(assistant_msg)
                for call in tool_calls:
                    fn = call["function"]
                    args = json.loads(fn["arguments"] or "{}")
                    result = await session.call_tool(fn["name"], args)
                    text = "\n".join(
                        b.text for b in result.content
                        if isinstance(b, TextContent)
                    )
                    tool_uses.append({"name": fn["name"], "arguments": args})
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": text,
                    })
    return {"answer": "No final answer produced.",
            "tool_uses": tool_uses}


def main() -> None:
    q = sys.argv[1] if len(sys.argv) > 1 else \
        "are we low on the top-selling product?"
    result = asyncio.run(run(q))
    print(f"Q: {q}")
    if result["tool_uses"]:
        print("tool calls:")
        for u in result["tool_uses"]:
            print(f"  - {u['name']}({json.dumps(u['arguments'])})")
    print(f"\nA: {result['answer']}")


if __name__ == "__main__":
    main()
