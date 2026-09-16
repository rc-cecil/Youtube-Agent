CREATE TYPE "AnalysisMethod" AS ENUM ('AI', 'HEURISTIC_FALLBACK');
CREATE TYPE "CandidateDecision" AS ENUM (
  'SELECTED',
  'REJECTED_LOW_INTEREST',
  'REJECTED_NO_PAYOFF',
  'REJECTED_DUPLICATE',
  'REJECTED_TOO_MUCH_CONTEXT',
  'REJECTED_VISUALLY_WEAK',
  'REJECTED_LOW_CONFIDENCE',
  'REJECTED_NO_CLEAR_EVENT',
  'REJECTED_POOR_SHORT_FORMAT'
);

ALTER TABLE "SourceVideo" ADD COLUMN "bitrate" INTEGER;

DROP INDEX IF EXISTS "VideoAnalysis_sourceId_key";
ALTER TABLE "VideoAnalysis"
  ADD COLUMN "analysisVersion" TEXT NOT NULL DEFAULT 'analysis-v2',
  ADD COLUMN "detectorVersion" TEXT NOT NULL DEFAULT 'detectors-v2',
  ADD COLUMN "scoringVersion" TEXT NOT NULL DEFAULT 'scoring-v2',
  ADD COLUMN "method" "AnalysisMethod" NOT NULL DEFAULT 'HEURISTIC_FALLBACK',
  ADD COLUMN "policySnapshot" JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX "VideoAnalysis_sourceId_version_key" ON "VideoAnalysis"("sourceId", "version");
CREATE INDEX "VideoAnalysis_sourceId_status_version_idx" ON "VideoAnalysis"("sourceId", "status", "version");

ALTER TABLE "HighlightCandidate"
  ADD COLUMN "eventStart" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "payoffEnd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "durationClass" TEXT NOT NULL DEFAULT 'QUICK',
  ADD COLUMN "durationReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "clusteringPolicy" TEXT NOT NULL DEFAULT 'generic-v1',
  ADD COLUMN "analysisMethod" "AnalysisMethod" NOT NULL DEFAULT 'HEURISTIC_FALLBACK',
  ADD COLUMN "decision" "CandidateDecision" NOT NULL DEFAULT 'REJECTED_LOW_CONFIDENCE',
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "shortWorthinessScore" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "duplicateScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "similarityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "duplicateEvidence" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "evidenceSummary" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "DetectedEvent"
  ADD COLUMN "eventStart" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "keyMoment" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "payoffEnd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "clusteringPolicy" TEXT NOT NULL DEFAULT 'generic-v1',
  ADD COLUMN "policySnapshot" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "HighlightScore"
  ADD COLUMN "chaos" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reactionStrength" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "storyCompleteness" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "commentPotential" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "shortWorthinessScore" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "decision" "CandidateDecision" NOT NULL DEFAULT 'REJECTED_LOW_CONFIDENCE',
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "analysisMethod" "AnalysisMethod" NOT NULL DEFAULT 'HEURISTIC_FALLBACK';

ALTER TABLE "GeneratedShort"
  ADD COLUMN "analysisMethod" "AnalysisMethod" NOT NULL DEFAULT 'HEURISTIC_FALLBACK',
  ADD COLUMN "publishable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "EditDecisionList" ADD COLUMN "editVersion" TEXT NOT NULL DEFAULT 'edit-v2';

ALTER TABLE "RenderArtifact"
  ADD COLUMN "frameRate" DOUBLE PRECISION,
  ADD COLUMN "bitrate" INTEGER,
  ADD COLUMN "renderPreset" TEXT NOT NULL DEFAULT 'HIGH',
  ADD COLUMN "renderVersion" TEXT NOT NULL DEFAULT 'remotion-v2',
  ADD COLUMN "sourceAssetKind" TEXT,
  ADD COLUMN "sourceSha256" TEXT,
  ADD COLUMN "presetConfig" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "ShortFeedback" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "shortId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShortFeedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShortFeedback_shortId_createdAt_idx" ON "ShortFeedback"("shortId", "createdAt");
CREATE INDEX "ShortFeedback_userId_createdAt_idx" ON "ShortFeedback"("userId", "createdAt");
ALTER TABLE "ShortFeedback" ADD CONSTRAINT "ShortFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortFeedback" ADD CONSTRAINT "ShortFeedback_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "HighlightCandidate" SET
  "eventStart" = "startTime",
  "payoffEnd" = "endTime",
  "durationReason" = 'Legacy candidate boundaries retained for archived baseline.';
UPDATE "DetectedEvent" d SET
  "eventStart" = c."startTime",
  "keyMoment" = c."eventTime",
  "payoffEnd" = c."endTime"
FROM "HighlightCandidate" c WHERE c.id = d."candidateId";
