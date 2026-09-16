ALTER TABLE "EditorialSettings"
  ALTER COLUMN "maxSourcePerDay" SET DEFAULT 3,
  ALTER COLUMN "sourceCooldownMinutes" SET DEFAULT 0;

-- Preserve explicit operator choices while upgrading untouched legacy defaults.
UPDATE "EditorialSettings"
SET "maxSourcePerDay" = 3,
    "sourceCooldownMinutes" = 0
WHERE "maxSourcePerDay" = 2
  AND "sourceCooldownMinutes" = 10;
