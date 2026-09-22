# Approved upgrade implementation progress

## Phase 1 — content types and baseline

The existing gameplay pipeline remains the default. Upload sessions and sources now persist
`AUTO`, `GAMEPLAY`, or `PODCAST`. Old rows receive `AUTO` through an additive migration.
`AUTO` resolves explicit game filename evidence first, a conservative podcast filename hint
second, and otherwise uses the existing generic gameplay path. A user choice wins over filename
inference. The resolved type, method, and detector profile are recorded in the append-only
analysis policy snapshot.

The central content strategy selects either the existing game-specific detector or a provisional
podcast audio-activity detector. The podcast detector deliberately does **not** infer laughter,
debate, speaker identity, or quotable statements from volume peaks. Until the later transcript
and editorial phases are complete, podcast candidates remain unranked signal-level drafts and
cannot become publishable Shorts through the gameplay prompt.

Validation: 100 tests passed, TypeScript typecheck passed, ESLint passed after fixing ten
pre-existing lint errors, and the production build passed. The additive migration applied to the local PostgreSQL database.
Prisma generated schema/types but the currently running local process holds the Windows engine
DLL open, so `prisma generate` exits with `EPERM` when replacing that unchanged DLL. Restart
the local API/worker before a clean regeneration. Vite/Vitest checks require an unsandboxed run
on this host because the sandbox cannot read their configuration files.

No archived EA Sports FC source, Short, render, or user data was deleted. No YouTube publication
was triggered.

## Remaining phases

Staged OpenAI routing and persistence; improved selection; optional Higgsfield; expanded
EDL/Remotion and editorial QC; UI/provenance/learning; and real-provider before/after acceptance
remain to be implemented and gated independently.

## Phase 2 — source transcript

Source-level transcripts now have append-only version/hash/config keys, per-chunk status and
provider usage, timed segments, speaker provenance, and an alignment model field. The worker
extracts bounded 16 kHz mono FLAC chunks with a one-second overlap, rejects any request near
the 25 MB API limit, and resumes successful chunks after a crash. Each word is assigned to
exactly one non-overlapping source-time core interval. The normalized source transcript text is
assembled from these owned aligned words; the primary model's unmodified transcription is
retained on each chunk. This avoids pretending GPT-4o JSON provides native word timestamps.

The routed primary models are Mini for normal gameplay, 4o Transcribe for HIGH, and Diarize for
podcast. Whisper remains the default alignment pass. Provider/model for text, timing, and speaker
are retained separately. Missing timestamps for non-empty speech are an error, not a silent
fabricated alignment. In mock/no-key mode, no provider call is made and no AI transcript is
claimed. The old clip transcription helper remains available for compatibility, but ranking and
Short planning now consume the same cached source transcript. Planning no longer retranscribes
every candidate.

The source transcript schema and migration are applied locally. The OpenAI key is empty, so
real-provider transcription and long-recording acceptance are unverified. Raw provider usage is
retained; estimated cost is null until a pricing/usage mapping can be verified for an actual
response. A clean `prisma generate` still needs a local app restart to release the Windows DLL.

## Phase 3 — in progress

Editorial model IDs are now chosen in a single router. The official OpenAI model catalog lists
`gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`, but this local project's account access
cannot be tested without an API key. Legacy vision/planning overrides remain effective.
Luna now runs a text-evidence, high-recall discovery review of all detector-proposed candidates;
it must return every candidate exactly once. Its priorities are persisted and passed to Terra,
but are not treated as visually verified events. This pass does not yet propose new windows
outside the detector pool. Existing visual verification uses the Terra route, Short edit planning
uses the Terra route, and an additional Sol final-ranking call consumes the Terra review and the source evidence when
OpenAI mode is configured. The final result, not the preliminary Terra result, drives the
persisted highlight decisions. Both stages have distinct hashes/cache entries and append-only
stage records with evidence references, structured scores, usage, and estimated cost when known.
Luna now supplies a separate, validated metadata pass after Terra edit planning, with three
titles, a grounded description, and checked hashtags. Its output feeds the actual EDL and Short
record; it is cached and persisted separately. Mock mode does not manufacture Luna or Sol reviews.
Edit-planning results are also persisted as stage records. Source-wide discovery beyond detector
windows, Terra editorial QC, and escalation remain pending.

Before paid editorial calls, the worker checks the current API project's permission for the
configured model IDs using OpenAI's model retrieval endpoint. With no key configured, this
check has not run here. `AI_STAGED_RANKING_ENABLED=false` is an explicit legacy fallback for a
project lacking Luna/Sol access; the default is the staged path.

## Phase 4 — selection policy extension

The existing content-driven 6–60 second bounds, variable-yield qualification, and persistent
multi-signal deduplication are preserved. Duplicate composite, shorter-clip overlap, and visual
similarity thresholds now come from validated runtime configuration. An optional JSON map allows
exact-game overrides without touching selection code. The resolved policy is used by both initial
qualification and persistent history comparisons. Each decision still stores its component scores,
thresholds, policy version, and matched prior ID for false-positive analysis.

## Phase 5 — Higgsfield provider foundation, not yet integrated

The server-only Higgsfield REST provider now validates configurable model paths, estimates a
request before the single generation POST, enforces per-Short and per-batch spending ceilings,
rejects unsafe status URLs, and polls a submitted request without following redirects. A
generation POST is deliberately never retried after an ambiguous timeout or server failure:
the provider may already have accepted a billable job. The estimate is bound to the exact
model and serialized arguments to prevent accidental submission with a stale estimate.

An additive `HiggsfieldGeneration` ledger migration is applied locally. It records the estimate,
input hash, model, one-shot submission state, provider request ID, status URL, result, and errors.
Preparation reserves a budget in a serializable transaction. A worker restart cannot turn a
`SUBMITTING` or `NEEDS_RECONCILIATION` row back into a billable POST automatically.

This is **not** a completed Higgsfield integration. Human-assisted reconciliation of
ambiguous submissions, output archival, model-specific argument validation, worker scheduling,
EDL placement, Remotion compositing, and fallback behavior are still required. The feature
remains disabled by default. No live API call was made and no generation cost was incurred.
Model paths must be selected from the current account-accessible catalog; no universal model
path is assumed. Provider unit tests passed; real API behavior awaits credentials and model
selection.
