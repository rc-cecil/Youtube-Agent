CREATE TABLE "AiStageResult" (
  "id" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "candidateId" TEXT,
  "shortId" TEXT, "stage" TEXT NOT NULL, "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL, "promptVersion" TEXT NOT NULL, "schemaVersion" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL, "evidenceRefs" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB NOT NULL, "scores" JSONB NOT NULL DEFAULT '{}',
  "inputTokens" INTEGER, "outputTokens" INTEGER, "estimatedCostUsd" DECIMAL(12,6),
  "cached" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiStageResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiStageResult_sourceId_stage_inputHash_provider_model_promptVersion_key"
  ON "AiStageResult"("sourceId", "stage", "inputHash", "provider", "model", "promptVersion");
CREATE INDEX "AiStageResult_sourceId_stage_createdAt_idx" ON "AiStageResult"("sourceId", "stage", "createdAt");
CREATE INDEX "AiStageResult_candidateId_stage_idx" ON "AiStageResult"("candidateId", "stage");
CREATE INDEX "AiStageResult_shortId_stage_idx" ON "AiStageResult"("shortId", "stage");
ALTER TABLE "AiStageResult" ADD CONSTRAINT "AiStageResult_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiStageResult" ADD CONSTRAINT "AiStageResult_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "HighlightCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiStageResult" ADD CONSTRAINT "AiStageResult_shortId_fkey"
  FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
