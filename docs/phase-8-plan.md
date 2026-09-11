# Phase 8 implementation plan

Phase 8 adds an evidence-bound learning layer to the verified Phase 7 analytics pipeline. It preserves the upload, analysis, rendering, editorial, publishing, and snapshot contracts and stops before Phase 9 production hardening.

## Architecture assessment

Phase 7 already retains immutable daily channel/video analytics and revenue observations, with owner-scoped publications linked to generated Shorts. The learning layer can therefore derive reproducible features and outcomes without querying Google from request handlers or mutating provider history. Existing editorial ranking is deterministic and diversity-safe, which provides a controlled place to add a bounded predicted-performance signal.

## Directory structure

- `packages/learning`: pure feature extraction, normalization, scoring, comparison, confidence, strategy, and experiment-allocation functions.
- `apps/worker/src/learning.ts`: durable learning-run claimant, snapshot-to-outcome materialization, insight generation, and audited strategy versioning.
- `apps/api/src/learning.ts`: owner-scoped learning, insight, strategy, and experiment endpoints.
- `apps/web/src/components/learning-workspace.tsx`: real AI Insights and Experiments workspaces plus the dashboard summary.
- `packages/db/prisma/migrations/202609110001_performance_learning`: Phase 8 persistence.

## Database plan

`LearningRun` records bounded retry state and analysis windows. `PerformanceFeature` captures immutable published-content inputs, including game, event, duration, slot, weekday, hook/opening/caption/edit/title/hashtag/audio attributes. `PerformanceOutcome` stores nullable horizon outcomes and the configured multi-signal performance score; unavailable short-horizon data remains null. `PerformanceInsight` stores finding, structured evidence, sample size, confidence, recommendation, and lifecycle. `StrategyConfig` is immutable and versioned, retaining previous/new values, reason, source metrics, exploration rate, and active status. `Experiment` and `ExperimentAssignment` retain hypotheses, allocation, variants, assignments, and results. Generated candidates retain predicted score/confidence/strategy provenance.

## Job architecture

The worker creates at most one due learning run per owner after sufficient fresh analytics. A PostgreSQL owner lock and active-run constraint make requests idempotent. Runs have PENDING/RUNNING/SUCCEEDED/RETRYING/FAILED states, three bounded attempts, lease recovery, and no external side effects. Feature and outcome keys make replay a no-op. Analytics completion can enqueue learning, while a periodic tick recovers missed work.

## Learning pipeline

1. Extract features from the immutable publication payload, selected concept, validated EDL, render facts, slot, and source.
2. Aggregate the latest video snapshots into age-aware 24h, 72h, and 7d outcomes; exact 1h/6h values remain unavailable because Phase 7 stores provider daily reports.
3. Compute a configurable score from retention, engaged-view rate, shares, subscriber conversion, and age-normalized velocity—not raw views alone.
4. Compare channel-relative cohorts across game, event, duration, slot, role, hook, caption use, edit intensity, and emoji use for 7/28/90/lifetime windows.
5. Apply recency weighting, winsorized outlier handling, minimum sample sizes, and LOW/MEDIUM/HIGH confidence.
6. Persist explainable insights with evidence and recommended bounded actions.
7. In autopilot, apply only sufficiently evidenced actions as a new immutable strategy version; otherwise expose an explicit Apply action.
8. Feed the active strategy into candidate prediction and daily-slate ordering while preserving HERO-first, duplicate, source-distribution, and adjacency guarantees.

## Experimentation

Experiments test one declared dimension with control and variant values, a minimum sample, and an allocation bounded by the active exploration rate. Assignment is deterministic per Short and experiment, auditable, and never silently reassigns a Short. Results use the same normalized outcomes and confidence rules. Users can draft, activate, pause, complete, or cancel experiments from `/experiments`.

## UI plan

`/ai-insights` presents run health, evidence-backed insight cards, sample/confidence/window labels, and strategy provenance. `/experiments` presents the exploration split, active/draft/completed experiments, sample progress, and real create/state controls. The Dashboard replaces the Phase 8 preview with a compact real-insights summary below the existing sole hero. Empty states explain the evidence threshold rather than displaying synthetic conclusions.

## Milestones and risks

1. Schema, pure learning package, and unit tests.
2. Durable worker, API, and integration tests.
3. Strategy-aware editorial ranking and deterministic experiment assignment.
4. Responsive UI, browser verification, documentation, and full repository gates.

YouTube daily reports cannot honestly supply exact 1h/6h outcomes, so those fields remain nullable with an availability reason. Small channels may legitimately produce no recommendations until minimum evidence is reached. Cohort correlation is not causal; UI copy must say “associated with,” and experiments are the mechanism for causal validation. Strategy changes are capped, versioned, reversible through activation, and never bypass quality or duplicate protections.
