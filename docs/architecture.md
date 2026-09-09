# Architecture and implementation plan

Source of truth: the user's 79-section master specification, supplied 2026-09-07. Phases 1–4 were completed sequentially under explicit user authorization; later phases remain design-only.

## 1. Existing architecture assessment

The repository `rc-cecil/Youtube-Agent`, at baseline `dd3ce60`, contains only a product README. There is no application, dependency manifest, database, infrastructure, or test suite to retain. Build a TypeScript npm-workspaces monorepo with independently runnable web, API and worker processes. Use React/Vite/Tailwind, Fastify REST, Prisma/PostgreSQL and BullMQ/Redis. Runtime never depends on Codex.

## 2. Directory structure

Phase 1 created `apps/web`, `apps/api`, `apps/worker`, and the foundation packages. Phase 2 added `video-analysis`; Phase 3 added `ai` and `game-detectors`; Phase 4 adds `apps/renderer` and `packages/remotion`. Later phases add YouTube, analytics, scheduling, and learning packages; do not create pretend implementations now.

## 3. Database schema plan

Phase 1: User owns Session, SourceVideo and UploadSession. UploadSession owns immutable numbered UploadParts; finalized uploads link to one SourceVideo. SourceVideo owns VideoAssets and JobRuns; JobRun stores durable queue intent, state, attempts, progress, timestamps, and safe error details. FailureEvent records failed attempts. AuditLog records authentication and upload actions. All user-facing reads and writes filter by owner. Session tokens are random, hashed at rest, expire and are revocable. Passwords use salted scrypt. Owner provisioning is an explicit CLI command; there is no public signup.

Source states preserve the specification: UPLOADED → PROCESSING → ANALYZING → READY or FAILED, with ARCHIVED reserved. In Phase 2, READY means ingestion and deterministic signal analysis completed, not that a final Short exists. Store actual container, video/audio codec, duration, dimensions, frame rate, audio presence, bytes, hash, and rights acknowledgment timestamp. Audio absence is valid and visible; it must not be fabricated.

Phase 2 adds one current `VideoAnalysis` per source, notable `AnalysisSignal` rows, owner-visible `HighlightCandidate` windows, and one `GameDetection` with explicit provenance and override state. `PROXY` and `THUMBNAIL` assets use deterministic generated keys. Reanalysis replaces derived signals/candidates while preserving originals and user game overrides.

Phase 3 adds one `DetectedEvent` and `HighlightScore` per ranked finalist plus immutable `AiResultCache` entries keyed by owner-bound content, provider, model, and prompt version. Scores retain all 15 specified dimensions, concise evidence, provider provenance, cache state, tokens, and estimated cost. Three private frame assets are retained per finalist for reproducibility; they are never directly exposed by the API.

Phase 4 adds User/Source/Candidate → GeneratedShort, three ShortConcept alternatives, versioned EditDecisionList, and RenderArtifact linked one-to-one to a durable RENDER JobRun. Review state is independent of render state and defaults to PENDING. Later migrations add: User → YouTubeConnection → Channel; GeneratedShort → schedule/publication records. Campaign owns unique channel/local-date/editorial-role ScheduleSlots; a slot owns publication attempts, and YouTubePublication has a unique external video ID and idempotency key. AnalyticsSnapshot and RevenueSnapshot use unique report-window/dimensions keys and retain history. PerformanceFeature, PerformanceInsight, Experiment and versioned StrategyConfig retain evidence and audit trails. Notifications reference jobs/publications. Use foreign keys, owner/channel indexes, unique deduplication constraints, UTC timestamps and explicit IANA timezone configuration. Monetary values use decimals and unavailable metrics remain null.

## 4. Job architecture

Commit the source, original asset, and PENDING JobRun in one database transaction. The worker reconciles persisted intents into BullMQ using the JobRun ID as a stable queue ID. This transactional outbox pattern survives Redis outages between upload and enqueue. BullMQ uses bounded attempts, exponential backoff, stalled-job recovery and separate worker concurrency. Jobs are replay-safe: terminal database success is a no-op, asset metadata is upserted, and deterministic media failures stop retries. Keep PENDING/RUNNING/SUCCEEDED/FAILED/RETRYING/CANCELLED, progress, attempt, timestamps and failure events. Workers heartbeat in Redis; API reports database, storage, Redis and worker readiness separately. An operator may explicitly retry failed ingestion. Shutdown drains work and closes connections.

Upload parts are bounded, streamed and individually hashed. Part retries must match; finalization is serialized and idempotent. Expired incomplete uploads are cleaned by the worker. Original files use generated keys, never supplied paths. An upload isn't READY until ffprobe validation and a complete FFmpeg decode check succeed. Commands use argument arrays, restricted protocols, bounded output and timeouts, without a shell. Long operations run outside API requests. Chunk assembly is streaming; future S3 multipart direct uploads can preserve the upload contract.

## 5. AI pipeline (Phases 2–3, 8)

Cheap proxy, cuts/motion/audio/HUD/OCR signals narrow candidates with setup/payoff context. A pluggable generic detector falls back on low-confidence game recognition; FC, GTA, COD and Fortnite adapters enrich signals. Inspect sampled candidate frames with a provider interface, model names from environment categories, schema-validated responses, content/model/prompt-version caching, quotas and cost accounting. Score all Section 14 features and keep concise evidence, never hidden chain-of-thought. Learning uses channel-relative outcomes, minimum sample sizes, rolling 7/28/90-day windows, confidence and audited bounded strategy changes with exploration.

## 6. Remotion pipeline (implemented in Phase 4)

Validate immutable EDL versions before the dedicated `short-rendering` queue. EDLs express source intervals, content-driven duration, measured dead-air cuts, crop/tracking strategy, selective captions, zoom/freeze/replay/overlays, and audio instructions. Remotion is the final 1080×1920 composition engine; FFmpeg normalizes retained audio and performs decode/boundary QC. The same `GameplayShort` component powers Studio, browser previews, smoke tests, and worker renders. Render artifacts become READY only after resolution, duration, audio, opening/ending frame, text safety, rights, and metadata checks pass. Rendering never runs in HTTP handlers.

## 7. YouTube integration (Phases 5–6)

Google OAuth uses minimal scopes, state/PKCE, secure callbacks, encrypted refresh tokens, disconnect/revoke and reconnect flows. An explicit `YOUTUBE_MODE=mock|live` adapter arrives in Phase 6; Phase 1 makes no YouTube calls. Upload privately through resumable Data API uploads, persist session and returned ID before schedule verification, and reconcile ambiguous results rather than blindly duplicate uploads. Rights acknowledgment and QC/approval gate publication. Store UTC instants plus channel IANA timezone (Africa/Accra default). Central configuration defaults to 12:00 DISCOVERY, 16:00 ENGAGEMENT and 20:00 HERO. Reserve the best concept for HERO first, then diversity-plan the other roles. Unique slot constraints and leases prevent duplicate assignment. Maintain 3–7 days of buffer, backups, watchdogs, alerts and 30-day/90-slot campaign visibility; external uptime is never guaranteed.

## 8. Analytics design (Phases 7–8)

Ingest actual supported Analytics/Data API metrics into idempotent daily snapshots; refresh recent publications more frequently. Store availability and collection timestamps, never turn unauthorized revenue into zero. Label estimated money and derived RPM distinctly; conversions require sourced, timestamped rates. Separate view age, slot, game and channel baseline in comparisons. Insights expose finding, evidence, sample size, confidence and recommendation, with audited strategy versions. No fake analytics cards in the Phase 1 shell.

## 9. Milestones and gates

1. **Foundation, this change:** workspace/tooling; migrations; login/logout/access control; chunk uploads/storage; ffprobe and decode worker; retries/outbox; responsive dashboard/upload/library/job/health surfaces; setup/API/runbook documentation. Gate: unit/API/security tests, real PostgreSQL+Redis+FFmpeg integration and browser flow, lint, strict typecheck and production build. Commit logically after verification.
2. Video analysis: proxy, signals, candidates, identification, generic detector.
3. Game intelligence: four adapters and AI ranking.
4. Short creation: concepts, validated EDL, Remotion, reframing, selective captions/effects and preview.
5. Editorial intelligence: slate planning, diversity, protected HERO, duplicate checks.
6. YouTube: OAuth, mock/live adapters, resumable publishing, timezone/DST/boundary tests and reconciliation.
7. Analytics: snapshot ingestion, measured dashboard and authorized estimated revenue.
8. Learning: features, evidence/confidence, comparisons, bounded audited adaptations and experiments.
9. Hardening: load/chaos tests, alerts, deployment, backups, recovery and additional security review. Security and retry basics begin in Phase 1; this milestone deepens them.

**Stop after Phase 4. Phase 5 requires a new user instruction.**

## 10. Known risks and decisions

- This Windows host initially exposes only Node/npm, with no Docker, PostgreSQL, Redis or FFmpeg on PATH. Provide container infrastructure and pursue real local dependency execution; report any unavailable verification honestly.
- Large uploads need bounded disk usage, resumability, expiration and recovery. Phase 1 uses application-mediated chunks (including for object storage), avoiding whole-file memory buffering. Horizontal local storage requires a shared volume; object storage removes that requirement.
- FFmpeg parses untrusted media. Restrict accepted containers/codecs and protocols, bound resources/time, and isolate the worker container. Header validation alone cannot prove file integrity, so decode fully before readiness. Very long footage may require tuning timeouts.
- Cookie authentication requires a same-origin frontend/API reverse proxy, HttpOnly cookies, production Secure cookies, origin checks on mutations, login rate limits and owner filtering. Internet deployments need TLS and controlled account provisioning.
- DB/Redis/storage transactions are not atomic together. Persist job intent in PostgreSQL, make side effects idempotent, serialize upload finalization and clean abandoned temporary objects.
- Model cost, uncertain game recognition, Remotion resource/licensing needs, YouTube verification/quota and metric availability must be revisited when those integrations are implemented against their current official documentation.
- The all-phase MVP acceptance scenario in Section 76 is not the Phase 1 acceptance gate. No highlighting, proxy, rendering, scheduling or publishing is claimed in this phase.
