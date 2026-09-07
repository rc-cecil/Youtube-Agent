# Phase 1 verification

Scope: foundation only. The user explicitly requires a separate instruction before Phase 2. No proxy, game detection, highlights, model calls, Remotion renders, or YouTube publication has begun.

## Verified in this workspace

- Windows, Node.js 24.20.0, npm 11.19.0; real PostgreSQL 18 via repository-local binaries; Memurai Developer 4.2.3 advertising Redis 7.4.9 compatibility; actual FFmpeg/ffprobe binaries.
- Committed Prisma migrations applied to fresh development and isolated test databases.
- Twenty unit tests cover salted passwords, session tokens, configuration, upload rights/type/path/size constraints, storage integrity, metadata parsing, process argument safety, and timeouts.
- Nineteen real API/DB/queue scenarios cover authentication, owner isolation, chunk/hash conflicts, resume state, concurrent completion, atomic source/job creation, queue-loss recovery, actual decode/metadata, duplicate execution, original download, corruption, manual retry, worker restart, automatic retry recovery/exhaustion, cleanup, dashboard/health, and session revocation. Format checks use real silent MOV/WebM and a truncated MP4.
- Playwright verified sign-in, file chooser/upload, rights acknowledgment, queued ingestion, completed metadata for a 1280×720 H.264/AAC file, desktop layout, and a 390px mobile source layout. Mobile document width equaled viewport width.

Browser media is synthetic and is not seed data. Verification accounts and uploads are removed after final testing. Visual artifacts under `output/playwright` are ignored.

## Environment-specific checks still required

- Docker/Compose images and nginx could not run because Docker/WSL are absent on this host. Native production TypeScript and Vite builds were executed.
- Cloud S3/R2 credentials were not supplied. The adapter is implemented; live bucket IAM, read/write/delete, and lifecycle-policy verification remain deployment checks.
- GitHub Actions is supplied; no hosted CI result is claimed until commits are pushed and the workflow runs.
- Small synthetic fixtures test correctness and recovery, not multi-hour capacity. Load testing and deployed hardening remain later milestones.

## Acceptance boundary

A provisioned user can sign in, upload owned MP4/MOV/WebM, resume interruptions, inspect real worker progress, obtain validated metadata, download the original, see failures, retry failed ingestion, and sign out. Dashboard numbers come from persisted records. Background work survives normal restarts and reconstructs missing queue intent. Later phases are documented without placeholder integrations.
