# Phase 4 verification

Scope: Short concept generation, structured edit decisions, Remotion composition/rendering, vertical reframing, selective captions/effects, output QC, preview, metadata editing, and manual review. Phase 1–3 authentication, uploads, storage, ingestion, analysis, game adapters, and ranking remain intact.

## Implemented

- A durable `PLAN` stage dynamically accepts every distinct candidate that clears adaptive evidence gates, up to a safety ceiling. It creates three genuinely different concepts for each accepted moment and selects one using ranked evidence. Mock mode is deterministic; OpenAI mode uses the Responses API with `store:false`, an owner pseudonym, prompt-cache key, and strict JSON-schema output.
- Planning generates short accurate titles, descriptions, preferred/banned hashtag handling, a first-second hook, a conservative crop strategy, and a content-driven duration. Measured interior silence can become jump cuts; exact source endings are trimmed to the final decodable frame.
- Versioned EDLs validate source/output bounds, the 60-second limit, cuts and speed, crop/tracking data, captions, zooms, freezes, replay, overlays, audio instructions, metadata, and safe first-second hook timing before render work is committed.
- `GameplayShort` is shared by Remotion Studio, the React Player preview, worker rendering, and the smoke test. It renders at 1080×1920 and supports CENTER, SMART_CROP, TRACKED_CROP, STACKED, BACKGROUND_BLUR, and GAMEPLAY_PLUS_FACE_CAM layouts plus declarative cuts, selective captions, zoom, freeze, replay, impact/progress overlays, audio ducking, and reduced copy-safe zones.
- The separate renderer queue/process creates isolated bundles, preserves original audio, applies loudness normalization, stores private H.264/AAC MP4s, and retains render history. HTTP handlers only create durable intents.
- QC requires full decode, 1080×1920 dimensions, expected duration/audio, visible opening and ending samples, safe/readable hook and captions, rights acknowledgment, and complete metadata before READY.
- `/shorts` and Short detail surfaces expose the real composition preview, source/ranking evidence, alternatives, validated EDL, render/QC history, metadata versioning, rerender, and approve/reject controls. Future slate and YouTube previews remain clearly disabled.
- Once a source has generated Shorts, reanalysis and game correction return `409 SHORTS_EXIST`; this prevents replacement of the ranked evidence underpinning durable concepts, EDLs, renders, and reviews.

## Verification gate

```sh
npm run db:generate
npm run db:migrate
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run test:render
npm run build
```

Local verification on 2026-09-09:

- Prisma Client generation and all five committed migrations: passed against development and isolated PostgreSQL databases.
- Strict TypeScript, ESLint with zero warnings, Prettier, and production build: passed.
- Unit/contract tests: 34 passed.
- Integration scenarios: 24 passed against real PostgreSQL, Redis-compatible BullMQ delivery, FFmpeg, Remotion Headless Shell, private storage, and the complete `INGEST → ANALYZE → RANK → PLAN → RENDER → QC → READY → APPROVED` path.
- Standalone Remotion smoke render: passed as a 1080×1920 H.264 MP4 with AAC audio.

The render integration first caught a genuine black terminal-frame condition at the source boundary. Planning now leaves a small final decode margin, and QC samples within the final quarter-second to avoid confusing AAC/container tail padding with video while still rejecting actual black endings.

## Boundary

Transcript generation is not fabricated: in OpenAI mode, audio-bearing candidate clips are transcribed with word timestamps and only speech close to the selected event becomes synchronized subtitle phrases. Silent or mock-mode clips receive conservative context captions rather than invented dialogue. `autopilotEnabled` is stored for the later publishing workflow but has no publishing side effect in Phase 4; manual approval is the only active review mode. Editorial-role assignment, DailySlatePlanner, diversity/similarity enforcement, YouTube OAuth/upload/scheduling, analytics, and learning remain later phases.

Live OpenAI planning cannot be executed without deployment credentials/model access; automated tests exercise the exact request/strict-response contract with a deterministic transport and never spend credits. Production operators must review current Remotion licensing for their organization and configure sufficient renderer CPU, memory, browser, and scratch storage.
