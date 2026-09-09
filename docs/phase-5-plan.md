# Phase 5 implementation plan

## Assessment and scope

Phase 4 provides durable source jobs, ranked evidence, concepts, validated EDLs, private QC-approved renders, and manual review. Retain these contracts. Sections 22–24, 30–31, 48–49 and 66 govern editorial planning. Sections 34–36 inform the buffer and timezone design; actual YouTube scheduling belongs to Phase 6.

## Structure and persistence

Add `packages/editorial` for pure similarity, role scoring, date handling and DailySlatePlanner; `apps/worker/src/editorial.ts` for media fingerprints and durable planning; `apps/api/src/editorial.ts` for authenticated routes; and an operational calendar in the existing web shell. Add owner settings, daily slates, exactly three unique role slots, a globally unique Short reservation, cached visual fingerprints, explicit related-edit declarations, and independent editorial job records. Preserve migration history.

## Processing

The API records a durable request. A database-backed worker claims it with a lease, retries with bounded backoff, recovers after restart, and commits assignments atomically under an owner lock. No media processing runs in HTTP handlers. Fingerprints sample actual source frames using FFmpeg; text similarity uses a deterministic lexical embedding, explicitly distinguished from learned semantic embeddings. Missing transcript/object evidence is unavailable, never invented. Existing AI scores supply role scoring; historical performance signals remain unavailable until analytics exists.

Reserve HERO first from the best eligible candidate pool, then select DISCOVERY and ENGAGEMENT with role fitness, source distribution and adjacency checks, including the previous day's HERO. Check exact render hashes, source-content identity and overlapping moments globally; use frame hashes and text/visual similarity across sources. Intentional REPLAY/PART_2/ALTERNATE_EDIT exceptions require a related Short and reason, and never waive adjacency checks or exact-file duplication. Persist reasons, shortages, settings snapshots and audit records. Replanning replaces only future editorial assignments and is serialized.

## Interface and downstream boundaries

Extend the graphite/lime interface with date selection, the three role columns, real previews, explicit missing slots, protected HERO explanation, planning progress/errors, and settings. Short mutations invalidate affected reservations. No slot is described as uploaded, scheduled on YouTube, or published. Future publication consumes these reservations after another preflight. Analytics and learning do not receive fabricated signals.

## Verification and risks

Test role priority, source reuse, duplicate transforms/reuploads, explicit exceptions, configurable thresholds, cross-day adjacency, timezone/DST/date boundaries, account isolation, concurrent requests, recovery, and invalidation. Run all existing unit/integration/render tests, typecheck, lint, format and build. Document measured outcomes and commit. Principal risks are sparse pools, missing optional evidence, misleading visual matches, race conditions and stale reservations; missing slots with evidence take precedence over unsafe substitutions.
