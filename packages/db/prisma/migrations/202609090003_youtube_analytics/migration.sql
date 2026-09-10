ALTER TABLE "YouTubeConnection"
ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "analyticsState" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "revenueState" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "analyticsSyncedAt" TIMESTAMP(3);

CREATE TABLE "AnalyticsSyncRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "startDate" TEXT NOT NULL,
  "endDate" TEXT NOT NULL,
  "state" "JobState" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsSyncRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AnalyticsSyncRun_state_availableAt_idx" ON "AnalyticsSyncRun"("state", "availableAt");
CREATE INDEX "AnalyticsSyncRun_userId_createdAt_idx" ON "AnalyticsSyncRun"("userId", "createdAt");

CREATE TABLE "AnalyticsSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reportKey" TEXT NOT NULL UNIQUE,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "publicationId" TEXT,
  "channelId" TEXT NOT NULL,
  "videoId" TEXT,
  "scope" TEXT NOT NULL,
  "reportDate" TEXT NOT NULL,
  "views" BIGINT,
  "engagedViews" BIGINT,
  "estimatedMinutesWatched" DECIMAL(20,6),
  "averageViewDuration" DECIMAL(20,6),
  "averageViewPercentage" DECIMAL(20,6),
  "likes" BIGINT,
  "comments" BIGINT,
  "shares" BIGINT,
  "subscribersGained" BIGINT,
  "subscribersLost" BIGINT,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalyticsSyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnalyticsSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnalyticsSnapshot_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "YouTubePublication"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "AnalyticsSnapshot_userId_scope_reportDate_idx" ON "AnalyticsSnapshot"("userId", "scope", "reportDate");
CREATE INDEX "AnalyticsSnapshot_videoId_reportDate_idx" ON "AnalyticsSnapshot"("videoId", "reportDate");

CREATE TABLE "RevenueSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reportKey" TEXT NOT NULL UNIQUE,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "publicationId" TEXT,
  "channelId" TEXT NOT NULL,
  "videoId" TEXT,
  "scope" TEXT NOT NULL,
  "reportDate" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "estimatedRevenue" DECIMAL(20,6),
  "estimatedAdRevenue" DECIMAL(20,6),
  "estimatedPremiumRevenue" DECIMAL(20,6),
  "monetizedPlaybacks" BIGINT,
  "playbackBasedCpm" DECIMAL(20,6),
  "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalyticsSyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RevenueSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RevenueSnapshot_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "YouTubePublication"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "RevenueSnapshot_userId_currency_scope_reportDate_idx" ON "RevenueSnapshot"("userId", "currency", "scope", "reportDate");
CREATE INDEX "RevenueSnapshot_videoId_reportDate_idx" ON "RevenueSnapshot"("videoId", "reportDate");
