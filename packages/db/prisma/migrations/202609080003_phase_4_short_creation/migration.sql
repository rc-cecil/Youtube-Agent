CREATE TYPE "ShortState" AS ENUM ('DRAFT', 'EDIT_PLANNED', 'RENDERING', 'QC', 'READY', 'FAILED', 'ARCHIVED');
CREATE TYPE "ReviewState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "RenderState" AS ENUM ('PENDING', 'RENDERING', 'QC', 'READY', 'FAILED');

CREATE TABLE "ShortCreationSettings" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "autopilotEnabled" BOOLEAN NOT NULL DEFAULT false,
  "minimumHighlightScore" INTEGER NOT NULL DEFAULT 55,
  "minimumConfidence" INTEGER NOT NULL DEFAULT 50,
  "minimumQualityScore" INTEGER NOT NULL DEFAULT 55,
  "preferredHashtags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "bannedHashtags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShortCreationSettings_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ShortConcept" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "concept" TEXT NOT NULL,
  "hook" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShortConcept_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GeneratedShort" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "selectedConceptId" TEXT NOT NULL,
  "state" "ShortState" NOT NULL DEFAULT 'DRAFT',
  "reviewState" "ReviewState" NOT NULL DEFAULT 'PENDING',
  "title" TEXT NOT NULL,
  "titleCandidates" JSONB NOT NULL,
  "description" TEXT NOT NULL,
  "hashtags" TEXT[] NOT NULL,
  "game" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "editorialRole" TEXT,
  "sourceTimestamp" DOUBLE PRECISION NOT NULL,
  "duration" DOUBLE PRECISION NOT NULL,
  "confidence" INTEGER NOT NULL,
  "qualityScore" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GeneratedShort_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "EditDecisionList" (
  "id" TEXT NOT NULL,
  "shortId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "document" JSONB NOT NULL,
  "validatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditDecisionList_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RenderArtifact" (
  "id" TEXT NOT NULL,
  "shortId" TEXT NOT NULL,
  "editDecisionListId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "state" "RenderState" NOT NULL DEFAULT 'PENDING',
  "storageKey" TEXT,
  "bytes" BIGINT,
  "sha256" TEXT,
  "duration" DOUBLE PRECISION,
  "width" INTEGER,
  "height" INTEGER,
  "videoCodec" TEXT,
  "audioCodec" TEXT,
  "hasAudio" BOOLEAN,
  "qc" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RenderArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShortCreationSettings_userId_key" ON "ShortCreationSettings"("userId");
CREATE UNIQUE INDEX "ShortConcept_candidateId_key_key" ON "ShortConcept"("candidateId", "key");
CREATE INDEX "ShortConcept_candidateId_selected_idx" ON "ShortConcept"("candidateId", "selected");
CREATE UNIQUE INDEX "GeneratedShort_candidateId_key" ON "GeneratedShort"("candidateId");
CREATE UNIQUE INDEX "GeneratedShort_selectedConceptId_key" ON "GeneratedShort"("selectedConceptId");
CREATE INDEX "GeneratedShort_userId_createdAt_idx" ON "GeneratedShort"("userId", "createdAt");
CREATE INDEX "GeneratedShort_sourceId_createdAt_idx" ON "GeneratedShort"("sourceId", "createdAt");
CREATE INDEX "GeneratedShort_state_createdAt_idx" ON "GeneratedShort"("state", "createdAt");
CREATE UNIQUE INDEX "EditDecisionList_shortId_version_key" ON "EditDecisionList"("shortId", "version");
CREATE UNIQUE INDEX "RenderArtifact_jobId_key" ON "RenderArtifact"("jobId");
CREATE UNIQUE INDEX "RenderArtifact_storageKey_key" ON "RenderArtifact"("storageKey");
CREATE INDEX "RenderArtifact_shortId_createdAt_idx" ON "RenderArtifact"("shortId", "createdAt");
CREATE INDEX "RenderArtifact_state_createdAt_idx" ON "RenderArtifact"("state", "createdAt");

ALTER TABLE "ShortCreationSettings" ADD CONSTRAINT "ShortCreationSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortConcept" ADD CONSTRAINT "ShortConcept_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "HighlightCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedShort" ADD CONSTRAINT "GeneratedShort_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedShort" ADD CONSTRAINT "GeneratedShort_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedShort" ADD CONSTRAINT "GeneratedShort_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "HighlightCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedShort" ADD CONSTRAINT "GeneratedShort_selectedConceptId_fkey" FOREIGN KEY ("selectedConceptId") REFERENCES "ShortConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditDecisionList" ADD CONSTRAINT "EditDecisionList_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_editDecisionListId_fkey" FOREIGN KEY ("editDecisionListId") REFERENCES "EditDecisionList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
