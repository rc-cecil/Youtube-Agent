ALTER TABLE "HighlightScore"
ADD COLUMN "predictedPerformanceScore" DOUBLE PRECISION,
ADD COLUMN "predictionConfidence" TEXT,
ADD COLUMN "strategyVersion" INTEGER;

ALTER TABLE "GeneratedShort"
ADD COLUMN "predictedPerformanceScore" DOUBLE PRECISION,
ADD COLUMN "predictionConfidence" TEXT,
ADD COLUMN "strategyVersion" INTEGER;

CREATE TABLE "LearningRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "windowDays" INTEGER NOT NULL DEFAULT 90,
  "state" "JobState" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LearningRun_state_availableAt_idx" ON "LearningRun"("state", "availableAt");
CREATE INDEX "LearningRun_userId_createdAt_idx" ON "LearningRun"("userId", "createdAt");

CREATE TABLE "PerformanceFeature" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "shortId" TEXT NOT NULL UNIQUE,
  "publicationId" TEXT NOT NULL UNIQUE,
  "videoId" TEXT NOT NULL UNIQUE,
  "game" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "duration" DOUBLE PRECISION NOT NULL,
  "durationBucket" TEXT NOT NULL,
  "postingTime" TEXT NOT NULL,
  "dayOfWeek" TEXT NOT NULL,
  "hookType" TEXT NOT NULL,
  "openingFrameStyle" TEXT NOT NULL,
  "captionStyle" TEXT NOT NULL,
  "captionUsage" BOOLEAN NOT NULL,
  "editIntensity" TEXT NOT NULL,
  "facecamPresence" BOOLEAN NOT NULL,
  "titleLength" INTEGER NOT NULL,
  "emojiUsage" BOOLEAN NOT NULL,
  "hashtagSet" TEXT[] NOT NULL,
  "sourceType" TEXT NOT NULL,
  "concept" TEXT NOT NULL,
  "editorialRole" TEXT NOT NULL,
  "audioCharacteristics" JSONB NOT NULL,
  "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PerformanceFeature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PerformanceFeature_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PerformanceFeature_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "YouTubePublication"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PerformanceFeature_userId_extractedAt_idx" ON "PerformanceFeature"("userId", "extractedAt");
CREATE INDEX "PerformanceFeature_userId_game_eventType_idx" ON "PerformanceFeature"("userId", "game", "eventType");

CREATE TABLE "PerformanceOutcome" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "featureId" TEXT NOT NULL,
  "horizon" TEXT NOT NULL,
  "reportThrough" TEXT,
  "available" BOOLEAN NOT NULL DEFAULT false,
  "availabilityReason" TEXT,
  "ageHours" INTEGER NOT NULL,
  "views" BIGINT,
  "engagedViews" BIGINT,
  "watchMinutes" DECIMAL(20,6),
  "averageViewDuration" DECIMAL(20,6),
  "averageViewPercentage" DECIMAL(20,6),
  "likes" BIGINT,
  "comments" BIGINT,
  "shares" BIGINT,
  "subscribersGained" BIGINT,
  "subscribersLost" BIGINT,
  "estimatedRevenueUsd" DECIMAL(20,6),
  "performanceScore" DOUBLE PRECISION,
  "normalized" JSONB,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PerformanceOutcome_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "PerformanceFeature"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PerformanceOutcome_featureId_horizon_key" ON "PerformanceOutcome"("featureId", "horizon");
CREATE INDEX "PerformanceOutcome_horizon_available_observedAt_idx" ON "PerformanceOutcome"("horizon", "available", "observedAt");

CREATE TABLE "PerformanceInsight" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "window" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "segment" TEXT NOT NULL,
  "finding" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "sampleSize" INTEGER NOT NULL,
  "confidence" TEXT NOT NULL,
  "recommendedAction" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PerformanceInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PerformanceInsight_runId_fkey" FOREIGN KEY ("runId") REFERENCES "LearningRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PerformanceInsight_runId_window_dimension_segment_key" ON "PerformanceInsight"("runId", "window", "dimension", "segment");
CREATE INDEX "PerformanceInsight_userId_state_createdAt_idx" ON "PerformanceInsight"("userId", "state", "createdAt");

CREATE TABLE "StrategyConfig" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'ACTIVE',
  "config" JSONB NOT NULL,
  "previousConfig" JSONB,
  "reason" TEXT NOT NULL,
  "metricsUsed" JSONB NOT NULL,
  "sourceInsightId" TEXT,
  "explorationRate" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StrategyConfig_userId_version_key" ON "StrategyConfig"("userId", "version");
CREATE INDEX "StrategyConfig_userId_state_idx" ON "StrategyConfig"("userId", "state");

CREATE TABLE "Experiment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "hypothesis" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "controlValue" TEXT NOT NULL,
  "variantValue" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "allocationRate" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  "minimumSample" INTEGER NOT NULL DEFAULT 8,
  "results" JSONB,
  "confidence" TEXT NOT NULL DEFAULT 'LOW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "Experiment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Experiment_userId_status_createdAt_idx" ON "Experiment"("userId", "status", "createdAt");

CREATE TABLE "ExperimentAssignment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "experimentId" TEXT NOT NULL,
  "shortId" TEXT NOT NULL,
  "featureId" TEXT,
  "arm" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExperimentAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExperimentAssignment_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExperimentAssignment_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExperimentAssignment_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "PerformanceFeature"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ExperimentAssignment_experimentId_shortId_key" ON "ExperimentAssignment"("experimentId", "shortId");
CREATE INDEX "ExperimentAssignment_userId_assignedAt_idx" ON "ExperimentAssignment"("userId", "assignedAt");
