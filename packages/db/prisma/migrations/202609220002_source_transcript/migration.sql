CREATE TABLE "SourceTranscript" (
  "id" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "version" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL, "configHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "provider" TEXT NOT NULL DEFAULT 'openai', "model" TEXT NOT NULL, "alignmentModel" TEXT,
  "language" TEXT, "text" TEXT NOT NULL DEFAULT '', "errorCode" TEXT, "errorMessage" TEXT,
  "usage" JSONB NOT NULL DEFAULT '{}', "estimatedCostUsd" DECIMAL(12,6),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SourceTranscript_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceTranscript_sourceId_version_sourceHash_configHash_key"
  ON "SourceTranscript"("sourceId", "version", "sourceHash", "configHash");
CREATE INDEX "SourceTranscript_sourceId_status_completedAt_idx" ON "SourceTranscript"("sourceId", "status", "completedAt");
ALTER TABLE "SourceTranscript" ADD CONSTRAINT "SourceTranscript_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TranscriptChunk" (
  "id" TEXT NOT NULL, "transcriptId" TEXT NOT NULL, "index" INTEGER NOT NULL,
  "startTime" DOUBLE PRECISION NOT NULL, "endTime" DOUBLE PRECISION NOT NULL,
  "overlapBefore" DOUBLE PRECISION NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "text" TEXT NOT NULL DEFAULT '', "alignmentText" TEXT NOT NULL DEFAULT '',
  "usage" JSONB NOT NULL DEFAULT '{}', "errorCode" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TranscriptChunk_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TranscriptChunk_transcriptId_index_key" ON "TranscriptChunk"("transcriptId", "index");
ALTER TABLE "TranscriptChunk" ADD CONSTRAINT "TranscriptChunk_transcriptId_fkey"
  FOREIGN KEY ("transcriptId") REFERENCES "SourceTranscript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TranscriptSegment" (
  "id" TEXT NOT NULL, "transcriptId" TEXT NOT NULL, "chunkIndex" INTEGER NOT NULL,
  "startTime" DOUBLE PRECISION NOT NULL, "endTime" DOUBLE PRECISION NOT NULL,
  "text" TEXT NOT NULL, "speaker" TEXT, "confidence" DOUBLE PRECISION,
  "timeSource" TEXT NOT NULL, "textSource" TEXT NOT NULL, "speakerSource" TEXT,
  "alignment" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TranscriptSegment_transcriptId_startTime_idx" ON "TranscriptSegment"("transcriptId", "startTime");
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_transcriptId_fkey"
  FOREIGN KEY ("transcriptId") REFERENCES "SourceTranscript"("id") ON DELETE CASCADE ON UPDATE CASCADE;
