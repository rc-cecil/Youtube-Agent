CREATE TABLE "HiggsfieldGeneration" (
  "id" TEXT NOT NULL,
  "shortId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "argumentHash" TEXT NOT NULL,
  "arguments" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "providerRequestId" TEXT,
  "statusUrl" TEXT,
  "estimateUsd" DECIMAL(12,6) NOT NULL,
  "actualCostUsd" DECIMAL(12,6),
  "result" JSONB,
  "storageKey" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "submittedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HiggsfieldGeneration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HiggsfieldGeneration_providerRequestId_key"
  ON "HiggsfieldGeneration"("providerRequestId");
CREATE UNIQUE INDEX "HiggsfieldGeneration_shortId_kind_model_argumentHash_key"
  ON "HiggsfieldGeneration"("shortId", "kind", "model", "argumentHash");
CREATE INDEX "HiggsfieldGeneration_status_updatedAt_idx"
  ON "HiggsfieldGeneration"("status", "updatedAt");
CREATE INDEX "HiggsfieldGeneration_shortId_createdAt_idx"
  ON "HiggsfieldGeneration"("shortId", "createdAt");
ALTER TABLE "HiggsfieldGeneration" ADD CONSTRAINT "HiggsfieldGeneration_shortId_fkey"
  FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
