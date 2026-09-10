# Phase 7 analytics surface brief

Mode: Operate. Direction: verified performance desk.

## Direction contract

THESIS: Make verified YouTube outcomes operational; refuse a vanity dashboard that hides provenance or missing data.

OWN-WORLD: Graphite equipment surfaces, warm-white Manrope/Geist type, lime action keys, compact metric rails, and precise chart geometry.

STORY: Confirm connection and sync health, read channel movement, find the Shorts driving it, then inspect revenue and today’s slate.

FIRST VIEWPORT: The existing sole video hero stays on Dashboard. Analytics opens with a compact sync bar, seven-column metric rail, and a bounded non-animated trend; Sync analytics is the primary action.

FORM: Verified performance desk, extending source-footage desk candidate 4, seed `27da0a10` from `docs/ui-direction.md`. The chart/table disclosure is the signature interaction.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Quality bar: [`docs/phase-7-quality-bar.md`](phase-7-quality-bar.md).

Phase 7 extends the existing graphite-and-lime Shorts Studio rather than replacing it. The supplied animated gaming video remains the dashboard's single hero. Analytics begins below it as a dense, calm operational surface: channel identity and synchronization state, a tabular metric rail, a non-animated daily trend, today's publishing slate, and ranked Shorts. Dedicated `/analytics` and `/revenue` routes use the same information architecture without creating another dashboard shell or hero.

The visual contract is evidence-first. Every number comes from a persisted snapshot; missing and unauthorized values say “Unavailable,” omitted dates are not plotted as zero, and estimated/derived money is labeled at point of use. Recharts provides its accessibility layer and a disclosure exposes the same daily values as a table. Tabs, selects, links, and sync controls remain keyboard-operable and use the existing shadcn/Radix primitives.

Motion is limited to one transform/opacity entrance when the analytics workspace first mounts and a linear rotating sync glyph while an explicit request is being queued. Polling and chart refreshes do not animate. Existing reduced-motion and keyboard-input rules suppress both effects. Responsive behavior changes the metric rail from seven columns to three and then two, stacks the chart/ranking/slate, preserves horizontal access to window controls, and never introduces page-level horizontal scrolling.

Phase 8 is a boundary, not placeholder data. The existing preview now describes future evidence-backed learning, recommendations, and experiments and remains explicitly unavailable. Phase 7 does not generate insights, predictions, comparative claims, or automatic strategy changes.
