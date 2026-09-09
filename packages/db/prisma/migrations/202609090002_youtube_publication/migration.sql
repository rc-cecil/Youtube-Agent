CREATE TABLE "YouTubeConnection" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL UNIQUE,
 "channelId" TEXT NOT NULL, "title" TEXT NOT NULL, "avatar" TEXT, "subscribers" TEXT,
 "accessToken" TEXT NOT NULL, "refreshToken" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'CONNECTED', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "YouTubeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "YouTubeOAuthState" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "browserHash" TEXT NOT NULL,
 "verifier" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "YouTubeOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "YouTubePublication" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "shortId" TEXT NOT NULL UNIQUE,
 "channelId" TEXT NOT NULL, "renderKey" TEXT NOT NULL, "renderHash" TEXT NOT NULL,
 "bytes" BIGINT NOT NULL, "metadata" JSONB NOT NULL, "publishAt" TIMESTAMP(3) NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PENDING', "sessionUrl" TEXT, "uploadedBytes" BIGINT NOT NULL DEFAULT 0,
 "videoId" TEXT UNIQUE, "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "errorMessage" TEXT, "lastVerifiedAt" TIMESTAMP(3), "remoteStatus" JSONB, "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "YouTubePublication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "YouTubePublication_state_nextAttemptAt_idx" ON "YouTubePublication"("state", "nextAttemptAt");
CREATE TABLE "Campaign" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "startDate" TEXT NOT NULL,
 "endDate" TEXT NOT NULL, "timezone" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Campaign_userId_startDate_key" ON "Campaign"("userId", "startDate");
