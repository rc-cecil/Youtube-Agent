# Post-testing quality remediation implementation plan

This plan supplements the master specification and preserves the implemented Phase 1–9 contracts. It does not authorize publication of acceptance-test Shorts. The archived 19-Short EA Sports FC baseline remains immutable and all new analysis is append-only.

## Phase A — policy and provenance

- Centralize game/event-aware clustering, adaptive temporal sampling, duplicate thresholds, tracking confidence, duration bounds, and render presets.
- Persist policy versions, event anchors, analysis method, rejection decisions, duplicate components, render source provenance, and render configuration.
- Treat the approved values as calibrated defaults, not scattered constants.

Acceptance gate: Prisma migration, generated client, type checks, and policy unit tests pass.

## Phase B — real event intelligence and multimodal evidence

- Cluster detector events using game/event profiles with the generic 2.5-second gap only as fallback.
- Select content-driven 6–60 second boundaries around setup, key moment, and payoff.
- Sample sparse context, denser approach frames, a key-moment burst, and payoff frames; retain transcript, OCR, audio statistics, game metadata, detector evidence, perceptual hashes, and motion tracks.
- Use the configured OpenAI multimodal provider for production decisions. Missing credentials may run deterministic tests and heuristic drafts, but may not claim AI completion or produce publishable Shorts.

Acceptance gate: adaptive-sampling, clustering, source-media, and provider-contract tests pass. A real reprocess requires `OPENAI_API_KEY`.

## Phase C — ranking, variable yield, and deduplication

- Require the model to select or explicitly reject every candidate and score short worthiness, visual clarity, editability, context, story completeness, reaction, chaos, and comment potential.
- Generate as many qualified, non-duplicate Shorts as the source supports up to the configured safety ceiling; do not force three.
- Compare event identity, temporal overlap, perceptual visual hashes, semantic evidence, transcript evidence, and game identity. Persist every component and the matched record.
- Keep heuristic outputs draft-only and block them from editorial scheduling or YouTube publication.

Acceptance gate: variable-yield, rejection, explainable duplicate, and publishability tests pass.

## Phase D — EDL v2 and Remotion production rendering

- Store event anchors, content-driven cuts, word-timed captions, hook type, crop evidence, replays, effects, SFX instructions, audio instructions, analysis provenance, and versioned metadata in EDL v2.
- Use `TRACKED_CROP` only when confidence, jitter, missing-ratio, and point-count gates pass. Fall back to `SMART_CROP`, then `BLURRED_BACKGROUND` for layouts where a vertical crop would remove critical wide-frame information.
- Render directly from the immutable ORIGINAL asset through Remotion. Do not create a lossy proxy/intermediate for production.
- Keep PREVIEW, STANDARD, and maximum-quality HIGH presets centralized. HIGH currently uses PNG frame interchange, H.264 CRF 16, slow preset, AAC 192k, and source FPS capped at 60.
- Share the validated composition and dynamic metadata between Player, Studio, and Node rendering. Studio fixtures cover EA Sports FC, Call of Duty, GTA, and Fortnite.

Acceptance gate: EDL validation, tracking fallback, 1080×1920 audio render smoke test, source provenance, frame diversity, bitrate/FPS, and QC tests pass.

## Phase E — candidate workspace and feedback

- Expose real candidate video previews, decisions, evidence, scores, duplicate risk, analysis method, duration rationale, and rejection reasons.
- Support versioned EDL updates and structured feedback without mutating prior analysis.
- Show render preset/provenance/QC details and require HIGH + AI provenance for publication.

Acceptance gate: API ownership, revision, feedback, review, render, and publication-guard integration tests pass.

## Phase F — archived EA Sports FC reprocessing and acceptance

1. Capture the immutable OLD baseline with `npm run report:quality -- --snapshot`.
2. Configure a real `OPENAI_API_KEY`; keep `AI_MODE=openai` and YouTube publishing disabled for this run.
3. Reanalyze the archived source. The workflow archives prior Shorts but retains their rows and render artifacts.
4. Let analysis, real AI ranking, planning, and HIGH rendering complete. Do not publish.
5. Run `npm run report:quality` to produce exact OLD/NEW paths, metric comparisons, duplicate evidence, and a manual-watch list.
6. Manually watch the equivalent old/new event, strongest new candidate, a different-duration Short, a 60 FPS HIGH render, duplicate-elimination evidence, and the strongest Remotion edit.

Automated scores and QC never constitute final visual acceptance. Success may be declared only after the real provider run and manual review of the retained artifacts.
