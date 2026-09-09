# Phase 5: editorial intelligence

## Specification coverage

Sections 22 and 48: `DailySlatePlanner` gives the highest eligible HeroScore first choice, then searches Discovery/Engagement pairs using comprehension, reactions, sharing and payoff signals. Render order does not assign roles. Historical performance signals await analytics; current role scores are explainable heuristics, not predictions of actual reach.

Sections 23–24: configurable adjacency threshold, source-content identity, timestamp spacing, per-source daily cap, history-based source distribution, and comparisons with neighboring days. Short counts are visible per source. Similarity components include game, event, source, timestamps, hook, title, duration, template, inferred score-dominant tone, actual frame hashes, and supplied transcript/object evidence. Missing evidence is explicitly unavailable.

Section 49: exact render hashes, reuploaded source hashes and overlapping moments block duplicate assignment even with changed metadata/crops. Matching frame sequences plus concepts catch visual near-duplicates across sources. Explicit pair-specific REPLAY, PART_2 and ALTERNATE_EDIT declarations require a justification. They cannot bypass identical-file or adjacency checks. Declarations are audited.

Sections 30–31: only current READY renders with rights and metadata qualify. Manual mode requires APPROVED. Autopilot accepts PENDING only when highlight, confidence and quality thresholds all pass; REJECTED never qualifies. Rerender, metadata, review, reuse or settings changes invalidate future reservations when necessary and require replanning.

Sections 34, 57, 66: a real 7/30-day calendar, three centralized role times, IANA timezone, explicit UTC instants, missing slots, settings and optional 3–7-day automatic editorial buffer. Defaults are Africa/Accra and 12:00 / 16:00 / 20:00. Planning must finish before the first slot. Ambiguous and nonexistent DST times are rejected rather than silently shifted. These are editorial reservations; YouTube scheduling, campaigns/publication reconciliation and analytics remain later phases.

## Implementation and operation

Six cumulative Prisma migrations preserve existing data. Independent durable `EditorialRun` requests use PostgreSQL leases with attempt fencing and bounded backoff. Worker polling survives restarts and does not depend on an interactive coding session. Owner/candidate locks and unique slot/Short constraints serialize assignments. Missing compatible content is a successful partial plan with explicit empty slots, not a fake full slate.

HERO scans the entire eligible pool. Pair search considers the best 100 eligible candidates per remaining role to bound combinatorial work. Fingerprints are cached on source identity; optional OpenAI semantic vectors are cached by owner/Short, text hash and configured model. `AI_EMBEDDING_MODEL` enables the official embeddings API when `AI_MODE=openai`; unset/mock uses an explicitly labeled lexical fallback. No captions, objects, neural embeddings or historical performance are invented. Frame hashing is a heuristic and cannot prove that every arbitrary transformation is distinct.

The existing supplied-video hero remains unique. Efferd references inform hierarchy and framing only. Motion uses existing tokens, an accessible 250ms expanding disclosure, a sliding calendar view indicator, press feedback, and a brief hero-copy entrance. Reduced-motion and keyboard paths suppress positional transitions. Polling does not animate content or steal focus.

## Verification record

The full gate is `db:generate`, `db:migrate`, `typecheck`, `lint`, `format:check`, `test`, `test:integration`, `test:render`, and `build`. Tests cover HERO priority, sparse pools, transformed/reuploaded duplicate moments, exact renders, paired exceptions, source caps/cooldowns, repeated concepts, cross-day adjacency, vector comparison, missing evidence, 11:59/noon, DST, fractional offsets, month/year boundaries, invalid settings, owner isolation, concurrent first-use requests, real frame extraction, lease recovery, and reservation invalidation.

Integration tests require a dedicated database ending in `_test`. Optional `INTEGRATION_BROWSER_REVIEW=1` serves the isolated test account on port 3002 after the actual render/editorial checks; point Vite at that port. The pause expires after ten minutes or resumes on Ctrl+C, then tests and account/file cleanup continue. Credentials printed in this mode belong only to the temporary test account.

Verified on 2026-09-09: 51 unit tests and 27 real PostgreSQL/Redis/FFmpeg integration scenarios passed. Prisma generation, migrations and validation, TypeScript, zero-warning ESLint, formatting, production build and the real 1080×1920 H.264/audio Remotion smoke render passed. Windows sandbox restrictions required approved execution for build/media tooling. The production build emits two harmless annotation warnings from Zod dependency comments.

Edge browser review used the actual isolated integration account and rendered Short at 1440px desktop and 390px mobile widths. Calendar selection, real HERO assignment, sparse slots, settings disclosure and responsive stacking were checked. No horizontal overflow was observed; reduced-motion computed transition duration was 0s. The design detector's radius suggestions were aligned to the existing scale; its 12px supporting-label advisory matches the documented 11–13px label range.

Live embedding calls require deployment credentials and are contract-tested without spending credits. Docker deployment and live YouTube behavior are not claimed by this phase.
