# ShopIQ backend — FastAPI + MCP agent (Python 3.14)
# Build from the repo root so requirements.txt is in context:
#   docker build -f backend/Dockerfile -t shopiq-backend .
# (docker-compose.yml already wires this up.)

FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Non-root user — the container only reads code and talks to Postgres/OpenRouter.
RUN addgroup --system app && adduser --system --ingroup app app
USER app

# Backend source (context root, not this dir, so requirements.txt resolves).
COPY backend/ /app/

EXPOSE 8000

# Health endpoint + graceful shutdown. Single worker is fine for a demo API.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
