CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resourceKind" TEXT,
    "resourceId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OpsAlert_userId_dedupeKey_state_key" ON "OpsAlert"("userId", "dedupeKey", "state");
CREATE INDEX "OpsAlert_userId_state_severity_lastSeenAt_idx" ON "OpsAlert"("userId", "state", "severity", "lastSeenAt");

ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
