# Phase 8 verification

Phase 8 adds reproducible feature extraction, age-aware performance outcomes, rolling comparisons, evidence/confidence labels, bounded versioned strategy changes, predicted ranking signals, and experiment lifecycle controls while preserving Phases 1–7.

## Integrity constraints

- Learning uses only owner-scoped, persisted YouTube video observations.
- Daily report granularity supports measured 24h/72h/7d outcomes; 1h/6h remain explicitly unavailable.
- Minimum samples, recency weighting, 5th/95th percentile winsorization, and confidence labels guard recommendations.
- The multi-signal score combines retention, engaged views, shares, subscribers, and velocity rather than optimizing raw views alone.
- Strategy updates retain previous/new config, reason, metrics, source insight, version, and timestamp. Adjustments are capped at 15% and exploration at 20–30%.
- Predictions are persisted as ranking signals with confidence and strategy version, never shown as guarantees.

## Surfaces

The existing Dashboard keeps its sole supplied-video hero and adds a compact live learning ledger. `/insights` exposes evidence readiness, outcome maturity, strategy provenance, rolling windows, and applicable findings. `/experiments` creates and controls one-variable tests without duplicating the dashboard or hero.

## Verification record

Verified on 2026-09-11:

- `npm test`: 81 tests passed across five files, including five Phase 8 learning tests.
- `npm run test:integration`: 35 scenarios passed against PostgreSQL, Redis-compatible queues, and FFmpeg; the Phase 8 scenario exercised feature/outcome materialization, honest unavailable horizons, thin-evidence refusal, baseline strategy versioning, owner isolation, and experiment controls.
- `npm run test:render`: 1080×1920 H.264 with audio passed.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build`: passed.
- `prisma migrate deploy`: `202609110001_performance_learning` applied successfully to both local application and dedicated integration databases.
- Browser verification: authenticated `/ai-insights` and `/experiments` rendered at the narrow responsive breakpoint; experiment draft creation persisted and refreshed correctly. Disposable review data was removed afterward.

A real Google account is not required by automated tests; provider network behavior remains closed or mocked. Vite reports its existing large-chunk advisory, but the production build completes.
