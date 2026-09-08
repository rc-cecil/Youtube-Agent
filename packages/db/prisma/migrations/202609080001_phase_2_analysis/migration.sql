CREATE TABLE "VideoAnalysis" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "sampleRate" DOUBLE PRECISION NOT NULL,
  "sceneCount" INTEGER NOT NULL DEFAULT 0,
  "motionPeakCount" INTEGER NOT NULL DEFAULT 0,
  "audioPeakCount" INTEGER NOT NULL DEFAULT 0,
  "silenceSegmentCount" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VideoAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AnalysisSignal" (
  "id" TEXT NOT NULL,
  "analysisId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "timestamp" DOUBLE PRECISION NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  "duration" DOUBLE PRECISION,
  "evidence" JSONB,
  CONSTRAINT "AnalysisSignal_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GameDetection" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "game" TEXT NOT NULL,
  "edition" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL,
  "detectorProfile" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "overridden" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GameDetection_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "HighlightCandidate" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "analysisId" TEXT NOT NULL,
  "startTime" DOUBLE PRECISION NOT NULL,
  "eventTime" DOUBLE PRECISION NOT NULL,
  "endTime" DOUBLE PRECISION NOT NULL,
  "eventType" TEXT NOT NULL,
  "signalScore" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "signals" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HighlightCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VideoAnalysis_sourceId_key" ON "VideoAnalysis"("sourceId");
CREATE INDEX "AnalysisSignal_analysisId_kind_timestamp_idx" ON "AnalysisSignal"("analysisId", "kind", "timestamp");
CREATE UNIQUE INDEX "GameDetection_sourceId_key" ON "GameDetection"("sourceId");
CREATE INDEX "HighlightCandidate_sourceId_signalScore_idx" ON "HighlightCandidate"("sourceId", "signalScore");
CREATE INDEX "HighlightCandidate_analysisId_eventTime_idx" ON "HighlightCandidate"("analysisId", "eventTime");
ALTER TABLE "VideoAnalysis" ADD CONSTRAINT "VideoAnalysis_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisSignal" ADD CONSTRAINT "AnalysisSignal_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "VideoAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameDetection" ADD CONSTRAINT "GameDetection_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HighlightCandidate" ADD CONSTRAINT "HighlightCandidate_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HighlightCandidate" ADD CONSTRAINT "HighlightCandidate_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "VideoAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
