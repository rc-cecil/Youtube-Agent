# Phase 5 REST contract

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

## Editorial endpoints

| Method and path             | Behavior                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /settings/editorial`   | Owner's timezone, three role times, diversity guards and buffer settings                                        |
| `PATCH /settings/editorial` | Validated settings; invalidates future reservations                                                             |
| `POST /editorial/plan`      | `{date:"YYYY-MM-DD"}` → 202 durable idempotent active request; before first slot and within 90 days             |
| `GET /editorial`            | Owner's slates, slots, diagnostics, recent runs and source counts; publication unavailable                      |
| `PATCH /shorts/:id/reuse`   | `{kind,relatedShortId,reason}`; pair-specific replay/part-two/alternate-edit declaration, or null kind to clear |

## Upload protocol

1. Initiate with the actual filename, matching supported MIME, total bytes, and rights acknowledgment. IDs and paths are server-generated.
2. Divide the original into `chunkBytes` parts. The final part may be smaller. A retransmission with the same hash succeeds; changed bytes at the same index produce `PART_CONFLICT`.
3. On reconnect, GET the session and reselect the original file. The browser hashes each previously uploaded part before skipping it. A filename, size, or hash mismatch requires the original file or a fresh upload.
4. Complete after every part is present. Under a row lock, the API streams and rehashes stored parts, writes the original, and commits SourceVideo, VideoAsset, and PENDING JobRun. This does not wait for the worker. Concurrent completion cannot create duplicate jobs. If the response was lost, GET exposes `sourceId` and another completion returns it.
5. Poll the source or jobs. The worker validates the actual container, codec, dimensions, duration, frame rate, and full decodability; creates a review proxy; analyzes scene, motion, loudness, peaks, and silence; enriches candidates with a game adapter; and samples three frames per finalist for ranking. `hasAudio=false` is valid. Invalid media or ranking failures end in FAILED with concise details and can restart at the failed stage.

After ranking, planning creates three concepts per configured finalist and compiles the selected option into a validated EDL. Each generated Short commits a separate durable render intent. The renderer—not the API—bundles the composition, writes a private MP4, and marks it READY only after QC. The browser preview uses the same declarative component and source proxy while final media remains owner-authenticated.

Finalization streams large files and may take time. Proxies permit a 15-minute finalization response; chunk requests are bounded at 16 MiB. Expired sessions cannot accept data. Original downloads stream without loading the file into memory.

Every private lookup is owner-filtered, including derived assets, scores, concepts, EDLs, renders, media, review decisions, overrides, downloads, and retries. Someone else's resource returns 404. A Short cannot be approved until its newest render has passed QC. Rerendering resets approval to PENDING. Server infrastructure settings and account provisioning are environment/CLI operations. Phase 4 exposes no registration, password recovery, Google OAuth, scheduling, or publication endpoints.
