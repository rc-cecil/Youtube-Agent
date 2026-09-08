# AI Gameplay Shorts Agent

A creator workspace for turning uploaded gameplay into Shorts. **Phases 1–3 are implemented: foundation, ingestion, deterministic gameplay analysis, game-specific adapters, and explainable AI candidate ranking.** The [master specification](docs/master-specification.md) is the source of truth; the [Section 78 architecture plan](docs/architecture.md) maps the full product and its implementation phases.

## What works now

- React/TypeScript dashboard, uploads, searchable source library, analysis workspace, source details, job queue, system health and configuration view.
- Provisioned user accounts, salted password hashing, expiring database sessions, HttpOnly cookies, origin checks, rate limiting and per-owner access control.
- Resumable MP4/MOV/WebM uploads with configurable size limits, immutable hashed parts, rights acknowledgment, idempotent finalization and cleanup.
- PostgreSQL/Prisma persistence with committed migrations; Redis/BullMQ ingestion, analysis, and ranking jobs with durable dispatch, bounded retries, progress and failure history.
- Original-file storage through local and S3/R2 adapters, ffprobe metadata extraction and full FFmpeg decode validation in a separate worker.
- Bounded H.264/AAC review proxies and thumbnails, streamed scene/motion/audio analysis, silence detection, and candidate windows with setup/payoff context.
- FC, GTA, Call of Duty, and Fortnite signal adapters with a low-confidence generic fallback; sampled finalist frames; schema-validated 15-dimension highlight scores; audited game overrides that trigger reranking.
- A pluggable ranking provider: explicitly labeled deterministic mock mode by default, or live OpenAI multimodal analysis when credentials and a model are configured. Content hashes cache unchanged results; token usage and configurable cost estimates are persisted and shown.

**READY means ingestion, local signal analysis, and Phase 3 ranking completed.** Mock mode is a development fixture: it scores measured activity and never pretends to have understood frame content. Set `AI_MODE=openai`, `OPENAI_API_KEY`, and `AI_VISION_MODEL` for live visual interpretation. Remotion, YouTube, scheduling, analytics, and learning remain later phases.

## Quick start with Docker

Requires Docker Engine/Desktop with Compose. Bindings are localhost-only; the Compose passwords are for local development.

1. Copy `.env.example` to `.env`, then set `OWNER_EMAIL` and a unique `OWNER_PASSWORD` of 12–256 characters. Leave `APP_URL=http://localhost:5173` and `NODE_ENV=development` for local HTTP use. Do not commit `.env`.
2. Start the application:

   ```sh
   docker compose --profile app up --build -d
   ```

   PostgreSQL and Redis health checks run first; the migration service must succeed before the API and worker start. FFmpeg is included in the application image. Original assets and databases use named volumes.

3. Provision your account:

   ```sh
   docker compose exec api node dist/scripts/create-user.js
   ```

   The command refuses to overwrite an existing account. Remove `OWNER_PASSWORD` from `.env` afterward and recreate the API/worker containers to remove it from their environments.

4. Open **http://localhost:5173**, sign in, and upload footage you own or have permission to publish. Follow the recording from Queued → Validating → Analyzing → Ready. A malformed recording becomes Failed with an actionable message.

Logs: `docker compose logs -f api worker`. Stop services with `docker compose --profile app down`; named volumes remain. Do not add `--volumes` unless you intend to erase local databases and media.

## Native development

Requires Node.js 22.12+, PostgreSQL, Redis 7.4-compatible service, and FFmpeg/ffprobe on PATH. Docker can provide only the database and queue:

```sh
docker compose up -d postgres redis
npm ci
npm run db:generate
npm run db:migrate
npm run user:create
npm run dev
```

Copy `.env.example` first. `user:create` reads the account values described above. Open **http://localhost:5173** (use that hostname to match `APP_URL`; if you use `127.0.0.1`, change `APP_URL` too). The Vite proxy keeps browser requests same-origin. The default `AI_MODE=mock` needs no external credentials. For live ranking, configure the three OpenAI variables above; optional per-million-token price variables make the displayed cost an explicit estimate rather than an invented value.

Run services individually with `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web`. The API defaults to `127.0.0.1:3001`. If its port changes, set `API_PROXY_TARGET` when starting Vite. Use `npm run db:dev -- --name change_name` to create a development migration; `db:migrate` applies committed migrations.

### Current Windows workspace

This implementation was verified without system-wide database installs. Ignored `.tools` helpers contain embedded PostgreSQL 18, Memurai Developer (Redis 7.4-compatible), and FFmpeg binaries. The local `.env` uses PostgreSQL port **55432**, Redis port **56379**, and those binary paths. `node .tools/start-services.mjs` starts these already-downloaded helpers. They bind to loopback and retain PostgreSQL data in `.data/local-postgres`. They are not committed deployment dependencies. Provision your own account; verification accounts are removed after testing.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

The real integration suite also needs a dedicated database whose name ends in `_test`, plus Redis and FFmpeg. It generates small synthetic MP4/MOV/WebM fixtures and removes only its randomly named accounts, records and files. It uses an isolated BullMQ queue and never flushes Redis.

PowerShell example for the current local helpers:

```powershell
$env:DATABASE_URL = 'postgresql://shorts:shorts_local@127.0.0.1:55432/shorts_phase1_test'
npm run db:migrate
npm run test:integration
Remove-Item Env:DATABASE_URL
```

GitHub Actions defines the same gate against PostgreSQL and Redis services on Linux. See [Phase 3 verification](docs/phase-3-verification.md) for actual local results and remaining environment-specific checks. There is no Remotion Studio command yet; compositions and render tests are Phase 4.

## Production build and deployment boundary

```sh
npm run build
npm run start:api
npm run start:worker
```

Serve `apps/web/dist` behind a same-origin reverse proxy; `infra/nginx.conf` is the supplied example. Set `NODE_ENV=production`, an HTTPS `APP_URL`, real database/storage credentials, `AI_MODE=openai`, an OpenAI API key/model, and TLS at ingress. Production configuration rejects HTTP origins and development mock ranking, and uses Secure cookies. Keep PostgreSQL and Redis private. Backend secrets are never sent to the frontend.

The Compose file is a local development environment, not an internet deployment. Resource quotas, backups, alerts, infrastructure secrets and the target S3 bucket must be provisioned before exposure. The container build is supplied but could not be executed here because Docker is unavailable; native production outputs were built and checked.

See [.env.example](.env.example), [API contract](docs/api.md), [operations runbook](docs/operations.md), [architecture](docs/architecture.md), and [verification results](docs/phase-3-verification.md). Implementation intentionally stops at Phase 3.
