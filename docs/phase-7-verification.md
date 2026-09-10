# Phase 7 verification

Verified on 2026-09-10 against the Phase 7 implementation and the dedicated local integration database.

## Automated gates

- `npm run typecheck` — passed.
- `npm run lint` — passed with zero warnings.
- `npm run format:check` — passed.
- `npm test` — 4 files and 76 tests passed, including 7 analytics unit tests.
- `npm run test:integration` with `shorts_phase1_test` — 34 scenarios passed against PostgreSQL, Redis-compatible queues, and FFmpeg.
- `npm run test:render` — produced a verified 1080×1920 H.264 Short with audio.
- `npm run build` — production TypeScript and Vite build passed. Rollup reports the existing advisory for large application chunks; it is not a build failure.
- Prisma generation, migration deployment, and migration status were verified for the development and dedicated integration databases; both include `202609090003_youtube_analytics`.

## Phase 7 behavior exercised

- OAuth requests analytics read and monetary read scopes and persists the granted scope set.
- Sync requests are serialized, durable, owner-scoped, retryable, and idempotent.
- Channel and video observations remain immutable daily snapshots; duplicate polling cannot duplicate observations.
- Dashboard windows, daily series, ranked Shorts, individual Short analytics, USD/GHS revenue, and all five local attribution dimensions are returned from persisted data.
- Monetary permission denial remains `Unavailable`; it is never converted to zero.
- Missing report dates remain absent/null rather than being synthesized as zero.
- Estimated provider revenue and locally derived revenue per 1K views are labeled separately.
- The editorial recovery fixture pins both its availability and lease in the past, removing a sub-millisecond database-clock race from the restart assertion.

## Browser review

The authenticated app was checked in Edge at 1440×1100 and 390×844. Analytics retains a bounded chart with a visible series key, the daily table disclosure, reachable window controls, and no page-level mobile overflow. Revenue exposes Game, Event, Length, Slot, and Role attribution without introducing another dashboard or hero. Synthetic fixture video IDs intentionally return provider-thumbnail 404s; the local fallback rendered as designed.

The final review captures are under `.impeccable/review/`. The browser fixture contains no production data and is removed after review.

## External boundary

Automated tests use a closed YouTube transport. A real Google account was not connected during verification, so deployment still requires configured OAuth credentials, a redirect URI, renewed consent for the Phase 7 scopes, and a first successful provider sync.
