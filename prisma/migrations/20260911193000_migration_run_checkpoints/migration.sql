CREATE TYPE "MigrationRecordStatus" AS ENUM ('PLANNED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CONFLICT');

-- Preserve every historical run. A per-row legacy generation prevents previously valid
-- duplicate source hashes from colliding with each other or with production-safe runs.
ALTER TABLE "migration_runs" ADD COLUMN "scopeKey" TEXT;
ALTER TABLE "migration_runs" ADD COLUMN "toolingVersion" TEXT;
UPDATE "migration_runs"
SET "scopeKey" = 'legacy', "toolingVersion" = 'legacy:' || "id"::text
WHERE "scopeKey" IS NULL OR "toolingVersion" IS NULL;
ALTER TABLE "migration_runs" ALTER COLUMN "scopeKey" SET NOT NULL;
ALTER TABLE "migration_runs" ALTER COLUMN "scopeKey" SET DEFAULT 'full';
ALTER TABLE "migration_runs" ALTER COLUMN "toolingVersion" SET NOT NULL;
ALTER TABLE "migration_runs" ALTER COLUMN "toolingVersion" SET DEFAULT 'phase2-production-safe-v1';
CREATE UNIQUE INDEX "migration_runs_source_scope_tooling_key"
  ON "migration_runs"("sourceSha256", "scopeKey", "toolingVersion");

CREATE TABLE "migration_records" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "entityType" TEXT NOT NULL,
  "sourceIdentity" TEXT NOT NULL,
  "canonicalId" UUID,
  "stage" TEXT NOT NULL,
  "status" "MigrationRecordStatus" NOT NULL DEFAULT 'PLANNED',
  "metadata" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "migration_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "migration_records_runId_entityType_sourceIdentity_key"
  ON "migration_records"("runId", "entityType", "sourceIdentity");
CREATE INDEX "migration_records_canonicalId_idx" ON "migration_records"("canonicalId");
CREATE INDEX "migration_records_runId_status_idx" ON "migration_records"("runId", "status");
ALTER TABLE "migration_records" ADD CONSTRAINT "migration_records_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "migration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
