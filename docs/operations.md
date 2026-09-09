# Phase 6 operations

## Editorial planning

Apply all Prisma migrations and restart API and worker together. The worker polls durable editorial requests every ten seconds, with a fifteen-minute renewable lease, attempt fencing and three bounded attempts. Graceful shutdown drains active editorial work. Automatic planning is opt-in per account and maintains the configured 3–7-day editorial buffer before the first daily slot.

Default times are 12:00, 16:00 and 20:00 in Africa/Accra. Ambiguous or nonexistent local times are rejected. Missing distinct eligible Shorts remain explicit empty slots. Future reservations are invalidated when their eligibility or content changes; replan after review, metadata or settings changes. These reservations do not publish to YouTube.

Optional `AI_EMBEDDING_MODEL` enables semantic vectors with `AI_MODE=openai` and the server-side provider key. Without it, comparison reports a lexical fallback. Visual fingerprints use actual proxy frames. Monitor persisted EditorialRun state/errors and worker logs; no interactive coding session is required.

## Runtime ownership

- API owns sessions, owner-filtered reads, bounded chunk receipt, and streaming finalization.
- PostgreSQL owns durable source/job/session state. A source and PENDING job commit together.
- Redis/BullMQ delivers jobs using JobRun IDs; the worker reconstructs missing queue entries.
- Worker owns FFmpeg/ffprobe, ingestion, proxy/signal analysis, game adapters, sampled-frame ranking, retries, progress, heartbeat, upload cleanup, and expiration.
- Renderer owns the separate `short-rendering` queue, temporary Remotion bundles, H.264/AAC output, audio normalization, output QC, render progress, and its own heartbeat. API requests never render inline.
- Local storage holds originals/parts; S3/R2 uses the same contract. Local multi-process deployment needs a shared volume.

BullMQ's documented [job IDs](https://docs.bullmq.io/guide/jobs/job-ids), [idempotent work](https://docs.bullmq.io/patterns/idempotent-jobs), and [retry/backoff behavior](https://docs.bullmq.io/guide/retrying-failing-jobs) inform delivery. PostgreSQL retains terminal state after queue retention expires, so replaying a completed job is a no-op.

## Environment reference

| Variable                                               | Meaning                                         |
| ------------------------------------------------------ | ----------------------------------------------- |
| `DATABASE_URL`                                         | Required PostgreSQL URL; never browser-exposed  |
| `REDIS_URL`                                            | Required Redis URL                              |
| `APP_URL`                                              | Browser origin; HTTPS required in production    |
| `API_HOST`, `API_PORT`                                 | Bind address and port                           |
| `API_PROXY_TARGET`                                     | Optional Vite proxy upstream                    |
| `STORAGE_PROVIDER`                                     | `local` or `s3`                                 |
| `STORAGE_ROOT`                                         | Local storage root or S3 worker scratch base    |
| `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT` | S3/R2 target; bucket required for S3            |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`           | Optional SDK credentials; role chain also works |
| `MAX_UPLOAD_BYTES`                                     | Default 20 GiB per recording                    |
| `UPLOAD_CHUNK_BYTES`                                   | Default 8 MiB, maximum 16 MiB                   |
| `UPLOAD_TTL_HOURS`                                     | Incomplete-session lifetime, default 24 hours   |
| `MAX_ACTIVE_UPLOADS`                                   | Default five per account                        |
| `FFMPEG_PATH`, `FFPROBE_PATH`                          | Worker executable paths                         |
| `MEDIA_TIMEOUT_MS`                                     | Full decode timeout, default four hours         |
| `WORKER_CONCURRENCY`                                   | Default two, range 1–16                         |
| `RENDER_CONCURRENCY`                                   | Concurrent Short renders, default one           |
| `RENDER_TIMEOUT_MS`                                    | Per-render/normalization ceiling                |
| `REMOTION_BROWSER_EXECUTABLE`                          | Optional compatible Chromium executable         |
| `ANALYSIS_FPS`                                         | Grayscale activity samples/sec, default one     |
| `ANALYSIS_CANDIDATE_LIMIT`                             | Maximum generic windows/source, default 12      |
| `PROXY_MAX_WIDTH`                                      | Review proxy maximum width, default 720         |
| `AI_MODE`                                              | `mock` (default) or `openai` ranking provider   |
| `AI_FINALIST_LIMIT`                                    | Candidates sampled per source, default six      |
| `SHORTS_PER_SOURCE_LIMIT`                              | Planned finalists/source, default three         |
| `AI_TIMEOUT_MS`                                        | Ranking request timeout, default 120 seconds    |
| `OPENAI_API_KEY`                                       | Required server secret for `AI_MODE=openai`     |
| `AI_VISION_MODEL`                                      | Required model name for `AI_MODE=openai`        |
| `AI_REASONING_MODEL`                                   | Optional Short-planning model; vision fallback  |
| `AI_INPUT_USD_PER_1M`, `AI_OUTPUT_USD_PER_1M`          | Optional explicit cost-estimate rates           |
| `SESSION_HOURS`                                        | Session lifetime, default 24 hours              |
| `TIMEZONE`                                             | Validated IANA zone, default Africa/Accra       |
| `LOG_LEVEL`                                            | Structured log level                            |
| `OWNER_EMAIL`, `OWNER_PASSWORD`                        | One-time provisioning values                    |

`YOUTUBE_MODE=mock` disables all provider calls. For live mode, enable the YouTube Data API, configure a Web OAuth client, register the exact `APP_URL/api/youtube/callback` redirect, then set `YOUTUBE_MODE=live`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a stable `YOUTUBE_TOKEN_KEY` containing 32 random bytes as 64 hex characters. Losing that key makes saved tokens and resumable sessions unrecoverable. Never expose it to the browser or rotate it without a credential migration.

The worker polls publication records every ten seconds. It starts an official private resumable upload, persists the session, probes the acknowledged range before every chunk, schedules only after receiving a video ID, and verifies remote state. Five bounded attempts use provider Retry-After or exponential delay. `NEEDS_ATTENTION` requires an operator; reconnect authorization or inspect YouTube Studio before retrying. `MISSED` records a passed slot rather than silently changing its time. Disconnect does not cancel remote schedules.

## Recovery

**Interrupted upload:** choose Resume and reselect the original. Persisted hashes detect a wrong file before parts are skipped. If completion already committed, the UI opens its source. Expired sessions require a new upload.

**Redis unavailable:** finalization still commits the original and PENDING JobRun because the API does not enqueue directly. Worker reconciliation dispatches it when Redis returns. Use persistence and `noeviction`; never flush shared Redis. Lost entries reconstruct from unfinished database jobs.

**Worker stopped:** uploads stay Queued; health becomes unavailable after the 30-second heartbeat expires. Restart it. BullMQ handles stalled work, and repeated delivery after durable success is a no-op. Queue failures reconcile to database failures rather than permanent Running records. Three attempts bound each JobRun; manual retry creates a new audited run.

**FFmpeg or storage unavailable:** retryable failures create FailureEvents and RETRYING state with exponential backoff. After three attempts, the source fails. Correct configuration and use Retry processing; the API restarts the failed stage.

**Analysis recovery:** ingestion commits a separate PENDING analysis intent and moves the source to ANALYZING. Reconciliation also backfills previously validated Phase 1 sources. Reanalysis is serialized, replaces derived signals/candidates, and preserves a user-corrected game. Deterministic proxy keys make storage retries idempotent.

**Ranking recovery:** successful local analysis commits a separate PENDING `RANK` intent and stays ANALYZING until ranking succeeds. Reconciliation backfills Phase 2 analyses that never received a successful rank. Ranking samples only the configured finalists, validates strict structured output, and persists event evidence and all score dimensions atomically before READY. A failed rank retries only ranking, not ingestion or signal extraction. Manual game correction schedules a fresh rank with the selected adapter.

**Planning recovery:** ranked sources without generated Shorts receive a durable `PLAN` intent. Planning caches owner-bound provider output, persists three alternatives, selects one, removes only measured interior dead air, and validates the complete EDL before creating render work. It never invents transcript captions. A failed plan does not invalidate the source or discard ranked evidence.

**Source evidence boundary:** reanalysis and game correction are available until the first Short is generated. They return `409 SHORTS_EXIST` afterward so concepts, versioned EDLs, renders, and review decisions cannot be invalidated by replacing their ranked source evidence. Make source-level corrections before choosing Create Shorts.

**Render recovery:** a dedicated process reconciles only `RENDER` jobs. Each attempt copies a private source proxy into an isolated temporary bundle, renders with one browser concurrency unit by default, normalizes retained audio, then fully decodes and checks the artifact. Retryable infrastructure failures return the Short to EDIT_PLANNED; terminal or QC failures become FAILED with evidence. Use Re-render after correction. Superseded successful artifacts remain in history. Approval is reset when rerendering.

**Render QC:** READY requires a playable 1080×1920 H.264 output, expected audio presence, EDL-aligned duration, visible opening/final sampled frames, first-second hook and caption safety, rights acknowledgment, and complete title/hashtags. `npm run test:render` creates and removes a synthetic fixture. `npm run remotion:studio` creates `packages/remotion/public/sample-gameplay.mp4` (gitignored) and opens the shared composition.

**AI modes and cost:** `mock` is an explicitly labeled deterministic development/test fixture and performs no network calls or visual event claims. Production rejects mock mode. `openai` sends low-detail finalist frames to the Responses API with `store:false`, a pseudonymous safety identifier, and strict JSON-schema output. Never expose the API key to the browser. Cached results are owner-bound and include source/frame hashes, detector profile, provider, model, and prompt version. Estimated cost remains zero/unavailable until deployment supplies the per-million-token rates for its chosen model; those rates are configuration, not live pricing lookup.

**OpenAI failure:** 429 and 5xx responses are retryable within the normal three-attempt bound. Authentication, model-access, and other rejected requests fail immediately with a safe message. Correct `OPENAI_API_KEY`/`AI_VISION_MODEL`, then use Retry processing. A provider response that violates the score schema is rejected rather than partially persisted.

**Invalid media:** deterministic failures stop after one attempt. Re-export and upload again. Supported video codecs are H.264, HEVC, VP8/9, AV1, MPEG-4, and ProRes. Dimensions are 16–8192 pixels, frame rate >0–240 fps, duration >0–24 hours. Audio is optional. Originals remain available to their owner.

**Disk capacity:** pause ingress, restore space, then retry. Session limits and expiration bound active uploads but are not a storage quota. Assembly temporarily needs both parts and the original; plan at least twice in-flight capacity. Full decoding can be expensive for long footage.

**Cleanup:** the worker expires abandoned sessions, deletes completed/expired upload parts by their dedicated prefix, removes any uncommitted assembled original, and deletes expired sessions. Source originals remain. Configure an object-storage lifecycle rule for incomplete multipart uploads. A hard-killed S3 worker can leave scratch media; deployment should clean old scratch files while excluding active jobs.

**Database unavailable:** mutations fail visibly; the app does not claim acceptance. Restore PostgreSQL first. Back up PostgreSQL and media together because a database backup does not contain originals.

## S3/R2 deployment

Keep provider, bucket, endpoint, and credentials on backend services. Grant bucket-scoped list/get/put/delete/multipart permissions without public read. The adapter supports streamed multipart writes, reads, deletion, prefix cleanup, and worker materialization. Phase 1 routes chunks through the API rather than signed browser URLs. Bucket health checks reachability; deployment must verify write/read/delete permissions. No cloud account was available for a live round trip here.

## Production considerations

Use TLS and same-origin routing. Production mode requires HTTPS and Secure cookies. Keep PostgreSQL/Redis private. The container runs media work as a non-root user with CPU/memory and no-new-privileges settings. FFmpeg receives argument arrays, file-only protocols, and a MOV/MP4/Matroska/WebM demuxer allowlist; no remote URLs are accepted.

Finalization holds an upload row lock while streaming assembly in a bounded transaction. Slow object storage may justify a future finalization queue. Large-file load/chaos tests, stronger worker isolation, disk quotas, backup/restore exercises, and deployed alerts remain Phase 9 hardening tasks.
