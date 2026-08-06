# Docker — Complete Reference Notes

**Course:** ShopIQ Mentor Program — Day 1 (Environment)
**Audience:** Engineer with dev experience, new to containers
**Goal:** Understand *what* Docker is, *why* the industry uses it, and be able to run the exact commands ShopIQ uses daily — including how our own ShopIQ database container was created.

---

## 1. The Big Picture: Why Docker Exists

**The problem it solves:** *"It works on my machine."*

Before containers, every environment (your laptop, a teammate's laptop, a server) had slightly different OS versions, library versions, and configs. Code that ran on one machine would break on another.

**The Docker answer:** bundle the application *together with its entire runtime* (OS libraries, config, dependencies) into a single portable unit — the **container** — that runs identically everywhere.

**Containers vs. Virtual Machines (VMs):**

| | Virtual Machine | Container |
|---|---|---|
| What it virtualizes | Full OS (including kernel) | Just the app + its libraries |
| Size | GBs | MBs |
| Boot time | Minutes | Seconds |
| Overhead | High | Very low |
| Isolation | Strong (hardware level) | Good (process level) |
| Analogy | A whole building with its own utilities | A shipping container with standard fittings |

Containers share the host machine's kernel. A VM each runs its own kernel. That's why containers are fast and light — but also why a Linux container needs a Linux host.

---

## 2. The Two Core Concepts: Images vs. Containers

> **Image** = the *recipe*. A frozen, read-only snapshot of everything needed to run the app.
> **Container** = a *cake baked from the recipe*. A running instance of the image.

- An **image** sits on disk and does nothing by itself. It's a template.
- A **container** is created from an image, runs processes, and can be started/stopped/deleted.
- Deleting a container does **not** delete the image — you can bake another.
- An image can create many containers (e.g., same image, many instances).

**Anatomy of an image** (what's inside): a layered filesystem. Each `RUN` step in a Dockerfile adds a layer. Layers are cached and shared between images — that's why building is fast and images are small-ish.

---

## 3. Where Images Come From

There are **exactly two ways** to get an image:

### 3.1 Pull from a registry (someone else built it)

A **registry** is a central repository of images (like npm for packages). The biggest public one is **Docker Hub**.

```bash
docker pull pgvector/pgvector:pg16   # fetch an image from Docker Hub
```

- `pgvector/pgvector` → the image name (owner/repo)
- `pg16` → the **tag** (version). `latest` is a tag too — avoid it for reproducible work.

### 3.2 Build it yourself (you write a Dockerfile)

A `Dockerfile` is a plain-text recipe for your own image. You'll do this in Day 7 when packaging the ShopIQ backend. Example:

```dockerfile
FROM python:3.14-slim          # start from an existing image
WORKDIR /app                   # set the working directory
COPY requirements.txt .        # copy files in
RUN pip install -r requirements.txt
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Then:

```bash
docker build -t shopiq-backend:v1 .   # build the image, tag it shopiq-backend:v1
```

`FROM` is the crucial idea: **almost every Dockerfile starts from another image** — you never build from zero. Our Postgres container is the same idea in reverse: we pulled an image that someone already made by writing a Dockerfile.

---

## 4. How OUR ShopIQ Database Container Was Created (the exact commands)

**Step 1 — get the image** (I ran this at the very start of Day 1):

```bash
docker pull pgvector/pgvector:pg16
```

Why this image and not plain `postgres:16`? Because ShopIQ needs **pgvector** (vector search for RAG). `pgvector/pgvector:pg16` is just PostgreSQL 16 with the pgvector extension pre-installed — one image, both capabilities. That's the "one datastore, no sprawl" choice from the design doc.

**Step 2 — create and run the container:**

```bash
docker run -d \
  --name shopiq-db \
  -e POSTGRES_USER=shopiq \
  -e POSTGRES_PASSWORD=shopiq \
  -e POSTGRES_DB=shopiq \
  -p 5432:5432 \
  -v shopiq_pgdata:/var/lib/postgresql/data \
  pgvector/pgvector:pg16
```

**Flag-by-flag breakdown:**

| Flag | Meaning |
|---|---|
| `-d` | **detached** — run in the background (don't block your terminal) |
| `--name shopiq-db` | Give the container a human-readable name (instead of an ID) |
| `-e VAR=value` | Set an **environment variable** inside the container. Here: DB user/password/database name |
| `-p 5432:5432` | **Port mapping**: `HOST_PORT:CONTAINER_PORT`. Postgres listens on 5432 inside; we expose it on 5432 on your machine so any local tool can connect as if Postgres were installed locally |
| `-v NAME:/path` | **Named volume** for persistence. `shopiq_pgdata` lives on your disk; `/var/lib/postgresql/data` is where Postgres stores data inside the container. Without a volume, deleting the container deletes your data |
| `pgvector/pgvector:pg16` | The image to create the container from |

**Note:** if you *hadn't* run `docker pull` first, `docker run` would have pulled it automatically. That's why it looked like the image came from nowhere.

---

## 5. The Core Command Set (memorize these)

### Images
```bash
docker images                  # list images on disk (+ size, tag)
docker pull <image>            # download an image
docker rmi <image>             # delete an image from disk
docker image prune             # remove dangling/unused images
```

### Containers
```bash
docker run <image>             # create + start a container (foreground)
docker run -d <image>          # create + start (detached/background)
docker ps                      # list RUNNING containers
docker ps -a                   # list ALL containers (incl. stopped)
docker stop <name>             # gracefully stop a container
docker start <name>            # start a stopped container
docker restart <name>          # stop then start
docker rm <name>               # delete a STOPPED container
docker rm -f <name>            # force-delete even if running
docker logs <name>             # print the container's stdout/stderr
docker logs -f <name>          # follow logs live (like `tail -f`)
docker inspect <name>          # full JSON metadata about the container
```

### Exec (running commands inside a container)
```bash
docker exec -it <name> <cmd>   # run a command inside a running container
```
- `-i` = interactive (keep stdin open), `-t` = allocate a TTY (terminal)
- Without `-it`, non-interactive commands like `docker exec shopiq-db psql -U shopiq -d shopiq -c "SELECT 1;"` work fine.

---

## 6. Intermediate Commands (you'll want these within a week)

```bash
docker top <name>              # processes running inside the container
docker stats                   # live CPU/memory usage of containers
docker cp <name>:/path ./      # copy files OUT of a container
docker cp ./file <name>:/path  # copy files INTO a container
docker port <name>             # show the container's port mappings
docker diff <name>             # files changed in the container vs. its image
docker rename <name> <newname> # rename a container
docker container prune         # delete all stopped containers
docker inspect -f '{{.State.Status}}' <name>   # one field from metadata (template syntax)
docker system df               # disk usage: images, containers, volumes, cache
docker system prune -a         # DANGER: remove ALL unused images/containers/cache
```

---

## 7. Advanced Topics (Docker in production)

### 7.1 Volumes — three flavors
| Type | Syntax | Lifetime |
|---|---|---|
| **Named volume** | `-v name:/path` | Survives container deletion (managed by Docker) |
| **Bind mount** | `-v /host/path:/path` | Points at a folder on your machine; used for live code reload in dev |
| **tmpfs** | `--tmpfs /path` | In-memory, lost on stop — for secrets/cache you never persist |

```bash
docker volume ls               # list volumes
docker volume inspect shopiq_pgdata   # where the data lives on disk
docker volume rm <volume>      # delete a volume (data gone forever!)
```

### 7.2 Dockerfile — the recipe for your own images
Key instructions:
| Instruction | Purpose |
|---|---|
| `FROM` | Base image (always first) |
| `WORKDIR` | Set working directory |
| `COPY` / `ADD` | Copy files from build context into image |
| `RUN` | Execute a command **at build time** (installing deps) |
| `ENV` | Set env vars baked into the image |
| `EXPOSE` | Document which port the app listens on |
| `CMD` | Default command **at run time** |
| `ENTRYPOINT` | Fixed command that always runs (arguments can be appended) |

`.dockerignore` — like `.gitignore`; excludes files (e.g. `node_modules`, `.venv`, `*.pyc`) from the build context so they never get copied into the image.

### 7.3 Docker Compose — multi-container apps
A `docker-compose.yml` file declares all services (db, backend, frontend), networks, volumes. One command starts everything:

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: shopiq
      POSTGRES_PASSWORD: shopiq
      POSTGRES_DB: shopiq
    ports:
      - "5432:5432"
    volumes:
      - shopiq_pgdata:/var/lib/postgresql/data
volumes:
  shopiq_pgdata:
```

```bash
docker compose up -d      # start all services (detached)
docker compose down       # stop and remove containers (volumes survive unless -v)
docker compose logs -f    # follow all services' logs
```

### 7.4 Networking (brief)
- Containers on the same **user-defined network** can talk to each other by name.
- `--network host` = share the host's network (no port mapping needed) — useful for local dev.
- Bridge (default) = isolated; you must publish ports to reach containers from the host.

### 7.5 Common troubleshooting
```bash
docker logs <name>                  # first thing when something "doesn't work"
docker ps -a                        # did the container even stay running?
docker start <name>                 # container "exited" = stopped, not broken
docker inspect <name> | grep -i ipaddress   # find a container's internal IP
```
Port conflict `Bind for 0.0.0.0:5432 failed` → something already uses 5432. `docker ps -a` and check, or change the host port (`-p 5433:5432`).

---

## 8. Best Practices (the habits, not just the commands)

1. **Always name containers** — debugging by ID is miserable.
2. **Always use named volumes for database data** — never lose data on a restart.
3. **Tag images explicitly** (`:v1`, `:pg16`) — never rely on `latest`.
4. **Pin base image versions** in Dockerfiles — reproducible builds.
5. **One container = one concern** — DB in one, backend in another. Don't cram.
6. **`docker system prune` with care** — it deletes things irreversibly.
7. **Credentials via `-e` or env files, never baked into an image** — this is how secrets leak.
8. **Stop containers you aren't using** to free resources (each running DB eats RAM).

---

## 9. Practice Drills

1. Run `docker ps` — confirm `shopiq-db` is running. What command started it? (Answer: the `docker run` above.)
2. Run `docker inspect shopiq-db -f '{{.State.Status}}'` — predict the output before running.
3. Run `docker logs shopiq-db` — find the line "database system is ready to accept connections".
4. Create a *second* database container from the same image on port 5433 named `shopiq-test`. Then `docker stop` it and `docker rm` it. (Proves: one image → many containers, deletion is painless.)
5. `docker volume ls` — see `shopiq_pgdata`. Explain why deleting the container won't lose our future data.
6. Try `docker run hello-world` (a tiny image that prints a test message) — then `docker rmi hello-world` to clean up.

---

## 10. Dockerizing the ShopIQ Backend (Day 7)

We don't just *run* a container — we now ship our own image. `backend/Dockerfile`
bundles the FastAPI + MCP agent; `docker-compose.yml` wires it to a Postgres
database. The image is **492 MB** (slim Python + the stack; no GPU, no browser).

### The Dockerfile (read it top to bottom)

```dockerfile
FROM python:3.14-slim                      # small base, pinned major.minor
ENV PYTHONUNBUFFERED=1 ...                 # sane Python defaults for logs
WORKDIR /app
COPY requirements.txt .                    # deps first → layer caching
RUN pip install -r requirements.txt        # fast rebuilds when code changes
RUN addgroup --system app && adduser ...   # non-root runtime user
USER app
COPY backend/ /app/                        # the source (single concern)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Design choices worth mentioning in an interview:

- **Deps before code** — Docker layers are cached; changing a `.py` file
  re-runs only the final `COPY`, not `pip install`.
- **Non-root user** — the container needs no host privileges; it only talks to
  Postgres and OpenRouter over the network.
- **`--host 0.0.0.0`** — inside a container "localhost" is the container
  itself; 0.0.0.0 makes uvicorn listen on all interfaces so the port
  forward works.
- **Build context = repo root** (the `-f backend/Dockerfile .` form) so the
  image can `COPY requirements.txt` from one source of truth.

### docker-compose.yml (two services, one concern each)

- `db` — `pgvector/pgvector:pg16`, healthchecked with `pg_isready`, and
  `schema.sql` auto-applied via `/docker-entrypoint-initdb.d/` on first boot.
- `backend` — built from `backend/Dockerfile`, `depends_on: db: service_healthy`
  (won't start until the DB is accepting connections), port `8000:8000`.
- **Secrets** come from the repo-root `.env` via `${VAR:-default}` interpolation
  — the compose file contains zero secrets. `POSTGRES_HOST: db` points at the
  compose network's DB service, not `localhost`.

```bash
docker compose up --build          # start the stack
curl localhost:8000/api/health     # {"status":"ok","tools":[...10...]}
docker compose down                # stop (volume keeps the data)
docker compose down -v             # stop AND wipe the DB volume
```

### Verified (this session)

Built the image and ran the stack manually (no compose plugin on this box):

```
curl localhost:8001/api/health        → 200, all 10 tools
GET  /api/policies                    → [] (fresh schema DB proves connectivity)
POST /api/policies  (smoke test doc)  → {"doc_id":1,"chunks":1}   ← embedded + persisted
GET  /api/policies                    → [('Container Smoke Test', 1)]
```

**Note:** a fresh compose DB starts with the *schema only* — seed it with
`docker compose run --rm backend python ingest_policies.py` (policies) and
`load_sales.py data/raw/online_retail_II.xlsx` (retail data) when you want a
full replica.
