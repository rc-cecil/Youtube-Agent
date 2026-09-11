# AI Gameplay Shorts Agent

A creator workspace for turning uploaded gameplay into measured YouTube Shorts. **Phases 1–9 are implemented**, including the foundation, analysis, AI ranking, Remotion editing/rendering, QC, editorial intelligence, YouTube publishing, analytics, learning, and production hardening. The [master specification](docs/master-specification.md) is the source of truth; the [architecture plan](docs/architecture.md) maps the full product.

## What works now

- React/TypeScript dashboard, uploads, searchable source library, analysis workspace, Shorts list/detail with shared Remotion preview, job queue, system health and configuration views.
- Provisioned user accounts, salted password hashing, expiring database sessions, HttpOnly cookies, origin checks, rate limiting and per-owner access control.
- Resumable MP4/MOV/WebM uploads with configurable size limits, immutable hashed parts, rights acknowledgment, idempotent finalization and cleanup.
- PostgreSQL/Prisma persistence with committed migrations; Redis/BullMQ ingestion, analysis, planning, and isolated rendering queues with durable dispatch, bounded retries, progress and failure history.
- Original-file storage through local and S3/R2 adapters, ffprobe metadata extraction and full FFmpeg decode validation in a separate worker.
- Bounded H.264/AAC review proxies and thumbnails, streamed scene/motion/audio analysis, silence detection, and candidate windows with setup/payoff context.
- FC, GTA, Call of Duty, and Fortnite signal adapters with a low-confidence generic fallback; sampled finalist frames; schema-validated 15-dimension highlight scores; audited game overrides that trigger reranking.
- A pluggable ranking provider: explicitly labeled deterministic mock mode by default, or live OpenAI multimodal analysis when credentials and a model are configured. Content hashes cache unchanged results; token usage and configurable cost estimates are persisted and shown.
- Three editorial concepts per finalist, truthful hook/title/hashtag planning, content-driven cuts with measured dead-air removal, and immutable schema-validated EDL versions.
- Reusable 1080×1920 Remotion compositions with six crop strategies, tracked framing data, selective captions, hard cuts, zoom/freeze/replay/overlays, audio ducking, and original-audio preservation.
- A dedicated renderer with loudness normalization, full output decode, resolution/duration/audio/boundary/safe-text/rights/metadata QC, private output storage, rerender history, and manual approve/reject controls.

- Daily editorial slates with protected HERO selection, distinct Discovery/Engagement roles, source distribution, global duplicate prevention, frame fingerprints, explicit related-edit exceptions, and a 7/30-day calendar.
- Durable editorial requests with leased execution, three bounded attempts, restart recovery, settings snapshots, owner locks, and unique Short reservations. Optional rolling editorial plans cover 3–7 days.
- Google OAuth with PKCE, browser-bound single-use state, encrypted tokens, channel identity, refresh/reconnect/revoke handling, and live mode disabled by default.
- Explicit private resumable YouTube uploads, audience/synthetic-media declarations, UTC scheduling, saved remote video IDs, reconciliation, cancellation verification, retry controls, and 30-day/90-slot campaigns.
- Recurring YouTube Analytics ingestion with immutable daily channel/video snapshots, manual sync, 7/28/90-day and captured-lifetime views, top-Short reporting, and per-Short analytics.
- Estimated YouTube revenue in provider-returned USD or GHS for today, 7 days, 28 days, month, and captured lifetime, with video/game/event/duration/slot/role attribution and clearly labeled locally derived revenue per 1,000 views.
- Evidence-backed learning with feature extraction, mature outcome windows, cautious recommendations, strategy versions, predictions, and experiments.
- Phase 9 hardening with durable operations alerts, stale-job watchdogs, backup verification records, deployment guardrail checks, authenticated operations reporting, stricter container health/security settings, and CI verification.

For a source, **READY** means ingestion, analysis, and ranking completed. For a Short, **READY** means its vertical artifact passed QC. Calendar assignments remain editorial reservations until an explicit publication request is accepted. `AI_MODE=mock` and `YOUTUBE_MODE=mock` perform no provider calls. Live YouTube requires `YOUTUBE_MODE=live`, Google OAuth credentials, an exact callback URL, and a stable 32-byte encryption key. Existing Phase 6 connections must reconnect once to grant the Analytics scopes. Phase 8 derives cautious comparisons only from persisted owner analytics; exact intraday horizons remain unavailable with daily provider reports.

## Quick start with Docker

Requires Docker Engine/Desktop with Compose. Bindings are localhost-only; the Compose passwords are for local development.

1. Copy `.env.example` to `.env`, then set `OWNER_EMAIL` and a unique `OWNER_PASSWORD` of 12–256 characters. Leave `APP_URL=http://localhost:5173` and `NODE_ENV=development` for local HTTP use. Do not commit `.env`.
2. Start the application:

   ```sh
   docker compose --profile app up --build -d
   ```

   PostgreSQL and Redis health checks run first; the migration service must succeed before the API, worker, and renderer start. FFmpeg and Chromium are included in the image. Original/rendered assets and databases use named volumes.

3. Provision your account:

   ```sh
   docker compose exec api node dist/scripts/create-user.js
   ```

   The command refuses to overwrite an existing account. Remove `OWNER_PASSWORD` from `.env` afterward and recreate the API/worker containers to remove it from their environments.

4. Open **http://localhost:5173**, sign in, and upload footage you own or have permission to publish. Follow the recording from Queued → Validating → Analyzing → Ready. A malformed recording becomes Failed with an actionable message.

Logs: `docker compose logs -f api worker renderer`. Stop services with `docker compose --profile app down`; named volumes remain. Do not add `--volumes` unless you intend to erase local databases and media.

## Native development

Requires Node.js 22.12+, PostgreSQL, Redis 7.4-compatible service, and FFmpeg/ffprobe on PATH. Docker can provide only the database and queue:

```sh
docker compose up -d postgres redis
npm ci
npx remotion browser ensure
npm run db:generate
npm run db:migrate
npm run user:create
npm run dev
```

Copy `.env.example` first. `user:create` reads the account values described above. Open **http://localhost:5173** (use that hostname to match `APP_URL`; if you use `127.0.0.1`, change `APP_URL` too). The Vite proxy keeps browser requests same-origin. The default `AI_MODE=mock` needs no external credentials. For live ranking, configure the three OpenAI variables above; optional per-million-token price variables make the displayed cost an explicit estimate rather than an invented value.

Run services individually with `npm run dev:api`, `npm run dev:worker`, `npm run dev:renderer`, and `npm run dev:web`. The API defaults to `127.0.0.1:3001`. If its port changes, set `API_PROXY_TARGET` when starting Vite. `npm run remotion:studio` creates a local two-second fixture and opens the composition. Use `npm run db:dev -- --name change_name` to create a development migration; `db:migrate` applies committed migrations.

### Current Windows workspace

This implementation was verified without system-wide database installs. Ignored `.tools` helpers contain embedded PostgreSQL 18, Memurai Developer (Redis 7.4-compatible), and FFmpeg binaries. The local `.env` uses PostgreSQL port **55432**, Redis port **56379**, and those binary paths. `node .tools/start-services.mjs` starts these already-downloaded helpers. They bind to loopback and retain PostgreSQL data in `.data/local-postgres`. They are not committed deployment dependencies. Provision your own account; verification accounts are removed after testing.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run test:render
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

GitHub Actions defines the same gate against PostgreSQL and Redis services on Linux and installs Remotion's compatible Headless Shell. See [Phase 9 verification](docs/phase-9-verification.md) for local results and limitations.

## Production build and deployment boundary

```sh
npm run build
npm run start:api
npm run start:worker
npm run start:renderer
```

Serve `apps/web/dist` behind a same-origin reverse proxy; `infra/nginx.conf` is the supplied example. Set `NODE_ENV=production`, an HTTPS `APP_URL`, real database/storage credentials, `AI_MODE=openai`, an OpenAI API key/model, and TLS at ingress. Production configuration rejects HTTP origins and development mock ranking, and uses Secure cookies. Keep PostgreSQL and Redis private. Backend secrets are never sent to the frontend.

The Compose file is a local development environment, not an internet deployment. Resource quotas, backups, alerts, infrastructure secrets and the target S3 bucket must be provisioned before exposure. The container build is supplied but could not be executed here because Docker is unavailable; native production outputs were built and checked.

See [.env.example](.env.example), [API contract](docs/api.md), [operations runbook](docs/operations.md), [architecture](docs/architecture.md), and [verification results](docs/phase-9-verification.md). Implementation now reaches the master specification's Phase 9 hardening boundary.
