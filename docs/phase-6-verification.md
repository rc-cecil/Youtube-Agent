# Phase 6 verification

Phase 6 connects the approved editorial slate to YouTube while preserving the Phase 1–5 upload, analysis, rendering, review, and planning contracts. Analytics and learning remain Phase 7 work.

## Implemented scope

- Google OAuth uses a one-time, browser-bound state, PKCE, the minimum YouTube upload scope, encrypted access and refresh tokens, refresh rotation, reconnect, and revocation-aware disconnect behavior. The UI exposes the connected channel title, avatar, channel ID, subscriber count, and health state without returning tokens.
- Publication creation is owner-scoped, explicit, and idempotent. It revalidates rights, review/autopilot eligibility, the newest READY render, metadata, audience selection, synthetic-content disclosure, and a future slot before freezing the publication snapshot.
- The worker uses YouTube's resumable upload protocol. It stores the session URL encrypted, probes the authoritative remote offset before every chunk, hashes and validates the local artifact, uploads bounded 8 MiB chunks, and recovers from an ambiguous response without initiating a duplicate upload.
- Every video begins private. Scheduling is applied only after a returned video ID is reconciled against YouTube, and a publication becomes `SCHEDULED` only after the remote private status and `publishAt` are verified. Successful HTTP responses alone never count as publication.
- Retry, cancellation, reconciliation, expired OAuth handling, bounded exponential backoff, attempt caps, missed-slot status, and actionable safe errors are surfaced in the calendar. Disconnecting explicitly warns that it does not cancel an already-created remote schedule.
- A 30-day campaign request creates idempotent daily editorial planning requests in the configured timezone. The campaign grid distinguishes published, remotely verified scheduled, locally reserved, and missing output; coverage is labeled as current state rather than a prediction.
- The existing dashboard hero remains the only hero. Phase 6 extends the editorial calendar with responsive publishing controls and restrained state-feedback motion, including reduced-motion and keyboard-path suppression.

## Verification performed

- Prisma client generation and schema validation passed.
- The Phase 6 migration applied to both the development database and the isolated integration database.
- Unit suites passed: 69 tests (foundation, editorial, and YouTube protocol/security coverage).
- Integration suite passed: 32 scenarios against PostgreSQL, Redis-compatible queues, FFmpeg/ffprobe, and a real Remotion render. YouTube network traffic was fully intercepted by a deterministic transport; unknown outbound requests fail the test.
- The resumable-upload integration simulates a lost completion response, then proves recovery by probing the existing session, obtaining one video ID, applying one schedule, and reaching verified `SCHEDULED` state with a single upload initiation.
- The 1080×1920 H.264 render smoke test with audio passed.
- Production build, TypeScript checks, lint, formatting, and repository diff checks are part of the final Phase 6 gate.
- The real calendar was inspected at desktop and 390 px mobile widths. It has no horizontal overflow, preserves hierarchy, exposes focusable controls, and disables nonessential transitions when reduced motion is requested.

## Safe test boundary

No live Google account was connected and no real YouTube video was uploaded, scheduled, cancelled, or published. `YOUTUBE_MODE=mock` remains the default. Live operation requires `YOUTUBE_MODE=live`, Google OAuth credentials, a 32-byte hex token key, the exact callback URI derived from `APP_URL`, and an authorized test channel. A controlled private test upload should be the first deployment smoke test before production scheduling is enabled.
