# Phase 3 verification

Scope: game intelligence and AI candidate ranking only. Phase 1 authentication, uploads, persistence, storage, and ingestion remain intact. Phase 2 proxy generation and deterministic scene, motion, audio, silence, and candidate discovery remain the cheap first stage.

## Implemented

- A durable `RANK` job follows local analysis and is recoverable from PostgreSQL if queue delivery is lost.
- FC, GTA, Call of Duty, and Fortnite adapters enrich observable signal patterns. Low-confidence or unsupported identification uses the generic detector, and adapters defer semantic claims until visual analysis.
- Ranking samples three representative low-detail frames for each finalist instead of sending the full recording.
- The provider abstraction supports an explicitly labeled deterministic mock and live OpenAI Responses API ranking configured entirely through environment variables.
- Strict validation requires game identification, one result per finalist, all 15 scoring dimensions, a 0–100 highlight score, confidence, event type, and a concise reason.
- Owner-bound content hashes cache unchanged results by source/frame content, detector profile, provider, model, and prompt version. Token usage and optional configured cost estimates are persisted and visible.
- Game correction is audited, selects the matching adapter, and triggers serialized reranking while preserving the original and Phase 2 analysis.
- Source and analysis screens expose ranking provenance, concise evidence, score breakdowns, and clear mock/live labels without presenting hidden reasoning.

## Verification gate

The release gate is:

```sh
npm run db:generate
npm run typecheck
npm run lint
npm run format:check
npm test
npm run db:migrate
npm run test:integration
npm run build
```

Local verification on 2026-09-08 completed successfully:

- Prisma Client generation and all four committed migrations: passed against PostgreSQL.
- Strict TypeScript, ESLint with zero warnings, and Prettier check: passed.
- Unit/contract tests: 30 passed.
- Integration tests: 22 scenarios passed against real PostgreSQL, Redis-compatible BullMQ delivery, and FFmpeg.
- Production TypeScript/Vite build: passed (1,988 modules transformed).

The integration suite uses real PostgreSQL, Redis-compatible BullMQ delivery, FFmpeg-generated MP4/MOV/WebM fixtures, durable `INGEST → ANALYZE → RANK` transitions, score/event persistence, cache reuse, owner isolation, game correction, and bounded retry behavior. Live OpenAI execution requires a separately supplied project key and model; automated tests exercise the exact request/response contract with a deterministic transport and never spend API credits.

## Boundary

Mock output is not represented as visual AI understanding. The OpenAI path is fully wired but cannot prove a deployment account's model access without that deployment's credentials. Model pricing is intentionally operator-configured because it varies over time; absent rates produce no fabricated cost. Remotion compositions, EDLs, rendered Shorts, YouTube, scheduling, analytics, and learning remain later phases.
