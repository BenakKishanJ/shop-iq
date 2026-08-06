# ============================================================================
# ShopIQ — single deployable image: frontend (static) + backend + PostgreSQL
# + RAG, all in one container. Build from the repo root:
#   docker build -f backend/Dockerfile -t shopiq .
# ============================================================================

# --- Stage 1: build the Next.js frontend to a static export (frontend/out) --
FROM node:22-alpine AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# NOTE: frontend/.env.local is excluded by .dockerignore, so NEXT_PUBLIC_API_URL
# stays unset here -> the UI fetches /api/* same-origin. Correct for the image.
RUN npm run build

# --- Stage 2: Python API + embedded PostgreSQL + static frontend ------------
FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    FRONTEND_DIST=/app/static

# Embedded PostgreSQL (one-container deploy). libpq-dev gives pg_config;
# postgresql-17-pgvector is the RAG vector extension the schema requires.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        postgresql libpq-dev postgresql-17-pgvector \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/lib/postgresql/*/main

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ /app/
COPY --from=frontend-build /build/out /app/static
COPY data/ /app/data/
RUN chmod +x /app/entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
