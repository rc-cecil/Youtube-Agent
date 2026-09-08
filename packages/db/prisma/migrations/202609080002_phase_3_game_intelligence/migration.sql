CREATE TABLE "DetectedEvent" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "confidence" INTEGER NOT NULL,
  "detectorProfile" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DetectedEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "HighlightScore" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "eventImportance" INTEGER NOT NULL,
  "excitement" INTEGER NOT NULL,
  "surprise" INTEGER NOT NULL,
  "skill" INTEGER NOT NULL,
  "humor" INTEGER NOT NULL,
  "tension" INTEGER NOT NULL,
  "emotionalReaction" INTEGER NOT NULL,
  "visualClarity" INTEGER NOT NULL,
  "contextIndependence" INTEGER NOT NULL,
  "hookPotential" INTEGER NOT NULL,
  "retentionPotential" INTEGER NOT NULL,
  "sharePotential" INTEGER NOT NULL,
  "novelty" INTEGER NOT NULL,
  "editability" INTEGER NOT NULL,
  "confidence" INTEGER NOT NULL,
  "highlightScore" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "cached" BOOLEAN NOT NULL DEFAULT false,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "estimatedCostUsd" DECIMAL(12,6),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HighlightScore_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AiResultCache" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "output" JSONB NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "estimatedCostUsd" DECIMAL(12,6),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiResultCache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DetectedEvent_candidateId_key" ON "DetectedEvent"("candidateId");
CREATE INDEX "DetectedEvent_sourceId_eventType_idx" ON "DetectedEvent"("sourceId", "eventType");
CREATE UNIQUE INDEX "HighlightScore_candidateId_key" ON "HighlightScore"("candidateId");
CREATE INDEX "HighlightScore_highlightScore_idx" ON "HighlightScore"("highlightScore");
CREATE UNIQUE INDEX "AiResultCache_inputHash_provider_model_promptVersion_key" ON "AiResultCache"("inputHash", "provider", "model", "promptVersion");
CREATE INDEX "AiResultCache_sourceId_createdAt_idx" ON "AiResultCache"("sourceId", "createdAt");
ALTER TABLE "DetectedEvent" ADD CONSTRAINT "DetectedEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DetectedEvent" ADD CONSTRAINT "DetectedEvent_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "HighlightCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HighlightScore" ADD CONSTRAINT "HighlightScore_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "HighlightCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiResultCache" ADD CONSTRAINT "AiResultCache_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
