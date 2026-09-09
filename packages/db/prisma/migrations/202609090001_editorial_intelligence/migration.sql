-- AlterTable
ALTER TABLE "GeneratedShort" ADD COLUMN     "reuseKind" TEXT,
ADD COLUMN     "reuseOfId" TEXT,
ADD COLUMN     "reuseReason" TEXT;

-- CreateTable
CREATE TABLE "EditorialSettings" (
    "userId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    "postingTimes" TEXT[] DEFAULT ARRAY['12:00', '16:00', '20:00']::TEXT[],
    "similarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.78,
    "maxSourcePerDay" INTEGER NOT NULL DEFAULT 2,
    "sourceCooldownMinutes" INTEGER NOT NULL DEFAULT 10,
    "bufferDays" INTEGER NOT NULL DEFAULT 3,
    "automaticPlanning" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditorialSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "DailySlate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL,
    "diagnostics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySlate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlateSlot" (
    "id" TEXT NOT NULL,
    "slateId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "localTime" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "shortId" TEXT,
    "score" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,

    CONSTRAINT "SlateSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortFingerprint" (
    "shortId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "frameHashes" TEXT[],
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "textHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortFingerprint_pkey" PRIMARY KEY ("shortId")
);

-- CreateTable
CREATE TABLE "EditorialRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EditorialRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailySlate_userId_localDate_key" ON "DailySlate"("userId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "SlateSlot_shortId_key" ON "SlateSlot"("shortId");

-- CreateIndex
CREATE INDEX "SlateSlot_plannedAt_idx" ON "SlateSlot"("plannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlateSlot_slateId_role_key" ON "SlateSlot"("slateId", "role");

-- CreateIndex
CREATE INDEX "EditorialRun_state_availableAt_idx" ON "EditorialRun"("state", "availableAt");

-- AddForeignKey
ALTER TABLE "EditorialSettings" ADD CONSTRAINT "EditorialSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySlate" ADD CONSTRAINT "DailySlate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlateSlot" ADD CONSTRAINT "SlateSlot_slateId_fkey" FOREIGN KEY ("slateId") REFERENCES "DailySlate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlateSlot" ADD CONSTRAINT "SlateSlot_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortFingerprint" ADD CONSTRAINT "ShortFingerprint_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "GeneratedShort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorialRun" ADD CONSTRAINT "EditorialRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
