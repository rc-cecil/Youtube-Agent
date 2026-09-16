# Phase 9 REST contract

Phase 9 preserves the Phase 8 learning and experiment API, then adds authenticated operations reporting: `GET /api/ops`, `PATCH /api/ops/alerts/:id`, and `POST /api/ops/backups/verified`. Mutation responses are audited; active learning requests are reused rather than duplicated.

All paths start with `/api`. JSON responses serialize byte counts as decimal strings to preserve PostgreSQL BigInt precision. Errors have `{ "code": "...", "message": "..." }` and an appropriate non-2xx status.

Authentication uses an HttpOnly `shorts_session` cookie. Its random value is hashed in PostgreSQL, expires after `SESSION_HOURS`, and is revoked on logout. Every mutation requires an `Origin` exactly matching `APP_URL`, including CLI API clients. Keep web and API same-origin through a reverse proxy. No permissive CORS configuration exists.

| Method and path                 | Behavior                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| `POST /auth/login`              | `{email,password}`; rate limited; sets cookie                      |
| `GET /auth/me`                  | Current account's public ID/email                                  |
| `POST /auth/logout`             | Revokes this session and clears cookie                             |
| `GET /config`                   | Non-secret limits, timezone, storage, phase, AI mode/model         |
| `POST /uploads`                 | `{filename,mimeType,bytes,rightsAcknowledged:true}` → 201 session  |
| `GET /uploads`                  | Current user's active incomplete sessions                          |
| `GET /uploads/:id`              | Session, received parts/hashes, expiration and completed source ID |
| `PUT /uploads/:id/parts/:index` | Raw `application/octet-stream`; exact part size required           |
| `POST /uploads/:id/complete`    | 202 source; repeated/concurrent calls return the same source       |
| `DELETE /uploads/:id`           | Expires an incomplete session for worker cleanup                   |
| `GET /sources`                  | `search`, `status`, `page`; 25 results/page, owner filtered        |
| `GET /sources/:id`              | Metadata, assets, analysis, candidates, jobs and failure history   |
| `GET /sources/:id/download`     | Authenticated original-file stream                                 |
| `GET /sources/:id/assets/:kind` | Authenticated `proxy` or `thumbnail` stream                        |
| `POST /sources/:id/analyze`     | 202 serialized reanalysis before Shorts exist; 409 afterward       |
| `PUT /sources/:id/game`         | Audited correction/reranking before Shorts exist; 409 afterward    |
| `POST /sources/:id/retry`       | 202 retry of latest failed ingestion, analysis, or ranking stage   |
| `POST /sources/:id/shorts`      | 202 serialized concept and EDL planning job                        |
| `GET /analysis`                 | Ranked finalists, score evidence, cached token/cost usage          |
| `GET /shorts/:id`               | Concepts, source/ranking evidence, EDL versions and render history |
| `GET /shorts/:id/media`         | Private stream of the latest QC-approved MP4                       |
| `POST /shorts/:id/render`       | 202 durable rerender job using the latest validated EDL            |
| `PATCH /shorts/:id/metadata`    | Version title, description and 1–6 validated hashtags              |
| `POST /shorts/:id/review`       | Approve a READY Short or reject a generated Short                  |
| `GET /settings/shorts`          | Short thresholds, future autopilot flag, preferred/banned tags     |
| `PATCH /settings/shorts`        | Validate and save all Short creation guardrails                    |
| `GET /jobs`                     | Latest 100 jobs for the current user's sources                     |
| `GET /dashboard`                | Actual source counts, bytes, duration and recent recordings        |
| `GET /health/live`              | Public process liveness only                                       |
| `GET /health`                   | Authenticated dependency readiness; 503 when degraded              |
| `GET /ops`                      | Active alerts, deployment checks, job counts and backup status     |
| `PATCH /ops/alerts/:id`         | Acknowledge or resolve an owner-scoped operations alert            |
| `POST /ops/backups/verified`    | Audited marker that database and media backups were verified       |

## Editorial endpoints

| Method and path             | Behavior                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /settings/editorial`   | Owner's timezone, three role times, diversity guards and buffer settings                                        |
| `PATCH /settings/editorial` | Validated settings; invalidates future reservations                                                             |
| `POST /editorial/plan`      | `{date:"YYYY-MM-DD"}` → 202 durable idempotent active request; before first slot and within 90 days             |
| `GET /editorial`            | Owner's slates, slots, diagnostics, recent runs and source counts; publication unavailable                      |
| `PATCH /shorts/:id/reuse`   | `{kind,relatedShortId,reason}`; pair-specific replay/part-two/alternate-edit declaration, or null kind to clear |

## Upload protocol

## Analytics endpoints

| Method and path             | Behavior                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /analytics/sync`      | Queue or return the owner's active analytics sync; four requests/hour                                         |
| `GET /analytics?window=28`  | `7`, `28`, `90`, or `lifetime` channel totals, daily series, top Shorts, today's slate, and campaign progress |
| `GET /analytics/shorts/:id` | Owner-scoped captured lifetime activity, estimated USD revenue, and publication state for one Short           |
| `GET /revenue?currency=USD` | `USD` or `GHS` estimated periods, top Shorts, and grouped attribution                                         |

Snapshot values can be `null` when a metric is not returned. Missing days are omitted rather than emitted as zero. Money is provider-reported estimated revenue; `derivedRevenuePerThousandViews` is the application's explicitly labeled calculation over captured views, not an official YouTube RPM. A monetary 403 leaves non-monetary analytics usable and returns the specified unavailable state/message.

## YouTube endpoints

| Method and path                         | Behavior                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /youtube`                          | Sanitized channel, future reserved slots, publications, and campaigns                |
| `POST /youtube/connect`                 | Creates browser-bound PKCE state and returns Google's authorization URL              |
| `GET /youtube/callback`                 | Consumes state once, exchanges code, reads channel, encrypts credentials, redirects  |
| `PATCH /youtube/publishing`             | Pause or resume owner-scoped YouTube publication work                                |
| `POST /youtube/disconnect`              | Revokes access, removes credentials; existing remote schedules remain                |
| `POST /youtube/publications`            | Explicit QC/rights/review preflight and idempotent private upload request for a slot |
| `POST /youtube/publications/:id/retry`  | Reconcile or resume a nonterminal publication                                        |
| `POST /youtube/publications/:id/cancel` | Request remote schedule removal and verification                                     |
| `POST /youtube/campaigns`               | Create a 30-day campaign and missing editorial planning requests                     |

Provider URLs, access/refresh tokens, encrypted upload sessions, raw remote errors, and credentials are never returned. Pausing publishing blocks new upload requests and stops non-cancellation worker publication steps; it does not delete already-created YouTube schedules. Active publication media and metadata are locked until cancellation is remotely verified. A 202 response means durable local acceptance, not successful upload or publication.

1. Initiate with the actual filename, matching supported MIME, total bytes, and rights acknowledgment. IDs and paths are server-generated.
2. Divide the original into `chunkBytes` parts. The final part may be smaller. A retransmission with the same hash succeeds; changed bytes at the same index produce `PART_CONFLICT`.
3. On reconnect, GET the session and reselect the original file. The browser hashes each previously uploaded part before skipping it. A filename, size, or hash mismatch requires the original file or a fresh upload.
4. Complete after every part is present. Under a row lock, the API streams and rehashes stored parts, writes the original, and commits SourceVideo, VideoAsset, and PENDING JobRun. This does not wait for the worker. Concurrent completion cannot create duplicate jobs. If the response was lost, GET exposes `sourceId` and another completion returns it.
5. Poll the source or jobs. The worker validates the actual container, codec, dimensions, duration, frame rate, and full decodability; creates a review proxy; analyzes scene, motion, loudness, peaks, and silence; enriches candidates with a game adapter; and samples three frames per finalist for ranking. `hasAudio=false` is valid. Invalid media or ranking failures end in FAILED with concise details and can restart at the failed stage.

After ranking, an adaptive quality gate decides how many distinct moments warrant Shorts; the result is not fixed at three. Planning creates three editorial concepts for each accepted moment and compiles the selected option into a validated EDL. In OpenAI mode, audio-bearing candidate clips also receive timestamped transcription so relevant speech near the event can become synchronized subtitles. Each generated Short commits a separate durable render intent. The renderer—not the API—bundles the composition, writes a private MP4, and marks it READY only after QC. The browser preview uses the same declarative component and source proxy while final media remains owner-authenticated.

Finalization streams large files and may take time. Proxies permit a 15-minute finalization response; chunk requests are bounded at 16 MiB. Expired sessions cannot accept data. Original downloads stream without loading the file into memory.

Every private lookup is owner-filtered, including derived assets, scores, concepts, EDLs, renders, media, review decisions, overrides, downloads, retries, OAuth state, channel credentials, publications, campaigns, sync runs, and analytics/revenue snapshots. Someone else's resource returns 404 or an empty disconnected view, as appropriate. A Short cannot be approved until its newest render has passed QC. Rerendering resets approval to PENDING. Server infrastructure settings and account provisioning are environment/CLI operations. The application exposes no public registration or password-recovery endpoints.
