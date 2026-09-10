# Phase 7 implementation plan

Phase 7 adds measured YouTube Analytics and estimated revenue to the verified Phase 6 channel/publication pipeline. It preserves all Phase 1–6 contracts and stops before Phase 8 learning, strategy adjustment, and experiments.

## Architecture assessment

The application already owns authenticated users, encrypted Google credentials, verified YouTube video IDs, immutable publication snapshots, daily editorial slots, and a PostgreSQL-polling worker. Those are the correct owner, identity, and scheduling boundaries for analytics. Phase 7 should extend them rather than introduce a second channel connection, scheduler, or dashboard shell.

## Package and API structure

- Add `packages/analytics` for YouTube Analytics query construction, strict result-table parsing, metric normalization, safe provider errors, and date/window helpers.
- Add `apps/worker/src/analytics.ts` for durable sync-run claiming, token refresh, targeted channel/video report collection, monetary availability handling, snapshot persistence, and recurring run creation.
- Add `apps/api/src/analytics.ts` for owner-filtered analytics, revenue, and manual-sync endpoints. Aggregate only persisted snapshots; browser requests never call Google directly.
- Add `apps/web/src/components/analytics-dashboard.tsx` for the dashboard overview plus dedicated `/analytics` and `/revenue` surfaces. Existing navigation, hero, calendar, and publishing UI remain intact.

## Database plan

- Extend `YouTubeConnection` with granted scopes and explicit analytics/revenue availability plus last successful synchronization time.
- Add durable `AnalyticsSyncRun` records with bounded retries and available-at scheduling.
- Add immutable `AnalyticsSnapshot` and `RevenueSnapshot` observations linked to a sync run. Each observation records report day, channel/video dimensions, collection time, nullable metrics, availability, and a run-scoped idempotency key. Re-syncs retain earlier observations instead of overwriting history.
- Store monetary values as decimals and currency per provider response. Missing or unauthorized monetary data remains unavailable, never numeric zero.

## Job and synchronization design

The worker creates at most one active sync per connected owner when the configured interval elapses. A run claims atomically, obtains a refreshed owner-bound token, fetches channel daily metrics and one batched daily/video report for system-owned YouTube IDs, then requests monetary reports separately in USD and GHS. Provider calls occur outside database transactions. Persistence is transactional and replay-safe by run-scoped report keys. Recent history is refreshed while every prior observation remains retained.

Authentication failures mark the channel for reauthorization. Retryable quota/server failures use bounded exponential delay. A denied monetary report marks revenue unavailable without discarding non-monetary analytics. Successful empty reports remain honest empty datasets because YouTube may omit recent unavailable days.

## Dashboard and revenue design

The existing dashboard gains a factual channel strip, today's three publication slots, a measured 28-day trend, and top Shorts only when snapshots exist. `/analytics` supports 7-, 28-, 90-day, and captured-lifetime windows with accessible tabular chart fallbacks. `/revenue` shows estimated values for today, 7 days, 28 days, month, and lifetime captured in provider-returned USD or GHS, including estimated ad/Premium revenue, monetized playbacks, playback-based CPM, and clearly labeled internally derived revenue per 1,000 views.

No insight sentence, prediction, or recommendation is generated in Phase 7. `/ai-insights` and `/experiments` remain clearly unavailable Phase 8 destinations rather than fabricated analytics.

## Verification and risks

Use a closed deterministic transport for OAuth scopes, result-table parsing, idempotent snapshot history, revenue denial, owner isolation, retry behavior, aggregation, and UI states. Extend the real PostgreSQL/Redis/FFmpeg/Remotion integration without any live Google request. Verify migrations, unit and integration tests, render smoke, type checking, lint, formatting, production build, desktop/mobile layouts, reduced motion, and accessibility. A controlled authorized channel sync remains a deployment smoke test because no Google credentials are available locally.
