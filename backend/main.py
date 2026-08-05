"""ShopIQ API: /api/chat wires the frontend to the agent loop.

Run:
    uvicorn main:app --port 8000   (from backend/)

Why the threadpool: the agent loop makes synchronous HTTP calls to OpenRouter
inside async MCP code. If it ran on the event loop it would block /api/health
for every other user. A worker thread keeps the API responsive.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import agent

app = FastAPI(title="ShopIQ API")
executor = ThreadPoolExecutor(max_workers=4)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    question: str
    model: str | None = None


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "tools": ["check_stock", "sales_trend",
                                      "top_sellers", "search_products",
                                      "search_policies", "flag_reorder",
                                      "notify_channel"]}


def _readable(exc: BaseException) -> str:
    """Unwrap ExceptionGroups (the MCP client re-raises as one) to the root."""
    if isinstance(exc, ExceptionGroup):
        return _readable(exc.exceptions[0])
    return str(exc)


@app.post("/api/chat")
async def chat(req: ChatRequest):
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: asyncio.run(agent.run(req.question, model=req.model)),
        )
        return {"answer": result["answer"], "tool_uses": result["tool_uses"]}
    except Exception as exc:
        return JSONResponse(status_code=503, content={"detail": _readable(exc)})
