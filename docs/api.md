# Phase 2 REST contract

All paths start with `/api`. JSON responses serialize byte counts as decimal strings to preserve PostgreSQL BigInt precision. Errors have `{ "code": "...", "message": "..." }` and an appropriate non-2xx status.

Authentication uses an HttpOnly `shorts_session` cookie. Its random value is hashed in PostgreSQL, expires after `SESSION_HOURS`, and is revoked on logout. Every mutation requires an `Origin` exactly matching `APP_URL`, including CLI API clients. Keep web and API same-origin through a reverse proxy. No permissive CORS configuration exists.

| Method and path                 | Behavior                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| `POST /auth/login`              | `{email,password}`; rate limited; sets cookie                      |
| `GET /auth/me`                  | Current account's public ID/email                                  |
| `POST /auth/logout`             | Revokes this session and clears cookie                             |
| `GET /config`                   | Non-secret upload limits, timezone, storage provider and phase     |
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
| `POST /sources/:id/analyze`     | 202 serialized durable reanalysis job after ingestion              |
| `PUT /sources/:id/game`         | Validated, audited game correction                                 |
| `POST /sources/:id/retry`       | 202 retry of latest failed ingestion or analysis stage             |
| `GET /analysis`                 | Current user's analyzed sources and top generic candidates         |
| `GET /jobs`                     | Latest 100 jobs for the current user's sources                     |
| `GET /dashboard`                | Actual source counts, bytes, duration and recent recordings        |
| `GET /health/live`              | Public process liveness only                                       |
| `GET /health`                   | Authenticated dependency readiness; 503 when degraded              |

## Upload protocol

1. Initiate with the actual filename, matching supported MIME, total bytes, and rights acknowledgment. IDs and paths are server-generated.
2. Divide the original into `chunkBytes` parts. The final part may be smaller. A retransmission with the same hash succeeds; changed bytes at the same index produce `PART_CONFLICT`.
3. On reconnect, GET the session and reselect the original file. The browser hashes each previously uploaded part before skipping it. A filename, size, or hash mismatch requires the original file or a fresh upload.
4. Complete after every part is present. Under a row lock, the API streams and rehashes stored parts, writes the original, and commits SourceVideo, VideoAsset, and PENDING JobRun. This does not wait for the worker. Concurrent completion cannot create duplicate jobs. If the response was lost, GET exposes `sourceId` and another completion returns it.
5. Poll the source or jobs. The worker validates the actual container, codec, dimensions, duration, frame rate, and full decodability, then creates a review proxy and analyzes scene, motion, loudness, peaks, and silence. `hasAudio=false` is valid. Invalid media ends in FAILED with concise details.

Finalization streams large files and may take time. Proxies permit a 15-minute finalization response; chunk requests are bounded at 16 MiB. Expired sessions cannot accept data. Original downloads stream without loading the file into memory.

Every private lookup is owner-filtered, including derived assets, overrides, downloads, and retries. Someone else's resource returns 404. Server settings and account provisioning are environment/CLI operations. Phase 2 exposes no registration, password recovery, Google OAuth, AI ranking, scheduling, or publication endpoints.
