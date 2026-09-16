-- A source can produce multiple Shorts, and each Short owns its own render job.
-- Keep singleton source-processing stages unique while allowing concurrent renders.
DROP INDEX IF EXISTS "JobRun_one_active_kind_per_source";

CREATE UNIQUE INDEX "JobRun_one_active_kind_per_source"
ON "JobRun" ("sourceId", "kind")
WHERE "state" IN ('PENDING', 'RUNNING', 'RETRYING')
  AND "kind" <> 'RENDER';
