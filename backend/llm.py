"""LLM chat client: conversation -> text via OpenRouter chat completions.

This is the module that Day 5 extends with tool calling. For now it's a
plain chat completion: send messages, get the assistant's text back.

Free-tier endpoints rate-limit (429); we retry with exponential backoff.
"""
import os
import time
import requests
from dotenv import load_dotenv

load_dotenv()

CHAT_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-oss-20b:free")
BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
MAX_RETRIES = 3
RETRY_BACKOFF = 2.0  # seconds, doubles each attempt


def _post(payload: dict) -> dict:
    """POST to chat/completions with retry-on-rate-limit / server errors."""
    last_error = None
    for attempt in range(MAX_RETRIES):
        resp = requests.post(
            f"{BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {os.getenv('OPENROUTER_API_KEY')}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=90,
        )
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (429, 500, 502, 503):
            last_error = resp.status_code
            retry_after = resp.headers.get("Retry-After")
            wait = float(retry_after) if retry_after else \
                RETRY_BACKOFF * (2 ** attempt)
            time.sleep(min(wait, 30))
            continue
        resp.raise_for_status()  # any other error is not transient: fail loud
    raise RuntimeError(f"OpenRouter request failed after {MAX_RETRIES} retries "
                       f"(last status {last_error})")


def chat(messages: list[dict], tools: list[dict] | None = None,
         model: str | None = None, temperature: float = 0.2,
         max_tokens: int = 1024) -> dict:
    """Send a conversation; return the full assistant message dict.

    With `tools`, the model may reply with tool_calls instead of text —
    the agent loop (Day 5) reads those and executes them.
    """
    payload = {
        "model": model or CHAT_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools
    return _post(payload)["choices"][0]["message"]


def complete(messages: list[dict], model: str = CHAT_MODEL,
             temperature: float = 0.2, max_tokens: int = 1024) -> str:
    """Send a conversation; return the reply text (plain chat, no tools)."""
    return chat(messages, model=model, temperature=temperature,
                max_tokens=max_tokens)["content"]


if __name__ == "__main__":
    print(complete([{"role": "user", "content": "Reply with exactly: OK"}]))
