-- Keep invariants at the persistence boundary as well as in request validation.
ALTER TABLE "SourceVideo" ADD CONSTRAINT "SourceVideo_positive_bytes" CHECK ("bytes" > 0);
ALTER TABLE "SourceVideo" ADD CONSTRAINT "SourceVideo_valid_duration" CHECK ("duration" IS NULL OR "duration" > 0);
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_positive_sizes" CHECK ("bytes" > 0 AND "chunkBytes" > 0);
ALTER TABLE "UploadPart" ADD CONSTRAINT "UploadPart_valid_sizes" CHECK ("bytes" > 0 AND "index" >= 0);
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_valid_progress" CHECK ("progress" BETWEEN 0 AND 100 AND "attempt" >= 0);
CREATE UNIQUE INDEX "JobRun_one_active_kind_per_source" ON "JobRun" ("sourceId", "kind")
WHERE "state" IN ('PENDING', 'RUNNING', 'RETRYING');
