"""ShopIQ API: /api/chat wires the frontend to the agent loop; /api/policies
and /api/actions power the dynamic policy library and the governance trail.

Run:
    uvicorn main:app --port 8000   (from backend/)

Why the threadpool: the agent loop makes synchronous HTTP calls to OpenRouter
inside async MCP code. If it ran on the event loop it would block /api/health
for every other user. A worker thread keeps the API responsive. (The policy
ingest path also makes blocking embedding calls.)
"""
import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import agent
import embeddings
import governance
import llm
from db import get_conn
from ingest_policies import parse_sections, upsert_document

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


class PolicyCreate(BaseModel):
    title: str
    content: str  # '## Section Heading\nbody' blocks


class ResolveBody(BaseModel):
    approved: bool
    resolved_by: str = "store-manager"


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "tools": ["check_stock", "sales_trend",
                                      "top_sellers", "search_products",
                                      "search_policies", "flag_reorder",
                                      "notify_channel", "list_actions",
                                      "approve_action", "list_policies"]}


@app.get("/api/health/llm")
async def health_llm():
    """Live probe of the chat model via OpenRouter."""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(executor, llm.probe)
    except Exception as exc:
        return JSONResponse(status_code=503,
                            content={"status": "error", "detail": _readable(exc)})


@app.get("/api/health/embeddings")
async def health_embeddings():
    """Live probe of the embedding model via OpenRouter."""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(executor, embeddings.probe)
    except Exception as exc:
        return JSONResponse(status_code=503,
                            content={"status": "error", "detail": _readable(exc)})


def _readable(exc: BaseException) -> str:
    """Unwrap ExceptionGroups (the MCP client re-raises as one) to the root."""
    if isinstance(exc, ExceptionGroup):
        return _readable(exc.exceptions[0])
    return str(exc)


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Stream the agent run as SSE events so the UI can show verbose
    thinking/tool activity live.

    The agent loop makes blocking HTTP calls, so it runs on the threadpool.
    Events hop from that thread back to the event loop via a thread-safe
    queue, and the async generator below drains it into `data: {...}` frames.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict] = asyncio.Queue()

    def worker() -> None:
        def on_event(ev: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, ev)
        try:
            result = asyncio.run(agent.run(
                req.question, model=req.model, on_event=on_event))
            loop.call_soon_threadsafe(queue.put_nowait, {
                "type": "done",
                "answer": result["answer"],
                "tool_uses": result["tool_uses"],
            })
        except BaseException as exc:  # noqa: BLE001 — bridge any failure to the stream
            loop.call_soon_threadsafe(queue.put_nowait, {
                "type": "error", "detail": _readable(exc)})

    async def events():
        while True:
            ev = await queue.get()
            yield f"data: {json.dumps(ev)}\n\n"
            if ev["type"] in ("done", "error"):
                return

    executor.submit(worker)
    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------
# Dynamic policy library
# --------------------------------------------------------------------------
def _policy_sections(conn, doc_id: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT section_label, content FROM document_chunks
               WHERE doc_id = %s ORDER BY chunk_index""",
            (doc_id,),
        )
        return [{"section": s or "Intro", "content": c}
                for s, c in cur.fetchall()]


@app.get("/api/policies")
def policies() -> dict:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT p.doc_id, p.title, p.source_type, p.raw_text,
                          p.created_at, COUNT(c.chunk_id) AS chunks
                   FROM policy_documents p
                   LEFT JOIN document_chunks c ON c.doc_id = p.doc_id
                   GROUP BY p.doc_id, p.title, p.source_type, p.raw_text,
                            p.created_at
                   ORDER BY p.title""",
            )
            docs = cur.fetchall()
        return {"documents": [
            {"doc_id": d[0], "title": d[1], "source_type": d[2],
             "raw_text": d[3], "created_at": d[4].isoformat(),
             "chunks": d[5], "sections": _policy_sections(conn, d[0])}
            for d in docs
        ]}
    finally:
        conn.close()


def _ingest_policy(title: str, content: str) -> dict:
    """Chunk + embed + upsert a new policy document (blocking HTTP)."""
    conn = get_conn()
    try:
        result = upsert_document({"title": title, "sections": parse_sections(content)}, conn)
        conn.commit()
        return result
    finally:
        conn.close()


@app.post("/api/policies")
async def create_policy(req: PolicyCreate):
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor, lambda: _ingest_policy(req.title, req.content))
        return {"doc_id": result["doc_id"], "chunks": result["chunks"]}
    except Exception as exc:
        return JSONResponse(status_code=503, content={"detail": _readable(exc)})


# --------------------------------------------------------------------------
# Governance trail
# --------------------------------------------------------------------------
@app.get("/api/actions")
def actions(limit: int = 40) -> dict:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT a.action_id, a.tool_name, a.arguments, a.result,
                          a.status, a.reasoning, a.created_at, a.resolved_at,
                          a.resolved_by, rf.flag_id, rf.suggested_quantity
                   FROM action_log a
                   LEFT JOIN reorder_flags rf ON rf.action_id = a.action_id
                   ORDER BY a.action_id DESC
                   LIMIT %s""",
                (limit,),
            )
            rows = cur.fetchall()
        return {"actions": [
            {"action_id": r[0], "tool_name": r[1], "arguments": r[2],
             "result": r[3], "status": r[4], "reasoning": r[5],
             "created_at": r[6].isoformat() if r[6] else None,
             "resolved_at": r[7].isoformat() if r[7] else None,
             "resolved_by": r[8], "flag_id": r[9], "suggested_quantity": r[10]}
            for r in rows
        ]}
    finally:
        conn.close()


@app.post("/api/actions/{action_id}/resolve")
def resolve(action_id: int, body: ResolveBody) -> dict:
    conn = get_conn()
    try:
        return {"message": governance.resolve_action(
            conn, action_id, body.approved, body.resolved_by)}
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Static frontend (single-image deploy). The Next.js static export
# (frontend/out) is served from the same process, so there is exactly one
# artifact to run. API routes are declared above, so /api/* always wins over
# this catch-all mount. Guarded by existence: a dev box without a build just
# has no UI, and the API still works.
# --------------------------------------------------------------------------
FRONTEND_DIST = os.getenv("FRONTEND_DIST", "../frontend/out")
if os.path.isdir(FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
else:
    print(f"[main] FRONTEND_DIST not found ({FRONTEND_DIST}) — serving API only")
