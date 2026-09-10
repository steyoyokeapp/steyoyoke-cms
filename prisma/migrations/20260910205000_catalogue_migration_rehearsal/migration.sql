ALTER TYPE "MediaStatus" ADD VALUE 'EXTERNAL';
CREATE TYPE "MediaProvider" AS ENUM ('LOCAL', 'LEGACY_EXTERNAL');
CREATE TYPE "MigrationIssueSeverity" AS ENUM ('BLOCKER', 'WARNING', 'COMPATIBILITY', 'INFORMATIONAL');

ALTER TABLE "media_assets"
  ALTER COLUMN "provider" DROP DEFAULT,
  ALTER COLUMN "provider" TYPE "MediaProvider" USING ("provider"::"MediaProvider"),
  ALTER COLUMN "provider" SET DEFAULT 'LOCAL',
  ALTER COLUMN "sourceStorageKey" DROP NOT NULL,
  ALTER COLUMN "originalFilename" DROP NOT NULL,
  ALTER COLUMN "mimeType" DROP NOT NULL,
  ALTER COLUMN "byteSize" DROP NOT NULL,
  ALTER COLUMN "sha256Checksum" DROP NOT NULL;

ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_provider_integrity" CHECK (
  ("provider" = 'LOCAL' AND "sourceStorageKey" IS NOT NULL AND "originalFilename" IS NOT NULL
    AND "mimeType" IS NOT NULL AND "byteSize" IS NOT NULL AND "sha256Checksum" IS NOT NULL)
  OR
  ("provider" = 'LEGACY_EXTERNAL' AND "kind" = 'AUDIO' AND "status" = 'EXTERNAL'
    AND "legacyAudioId" IS NOT NULL AND "sourceStorageKey" IS NULL AND "mimeType" IS NULL
    AND "byteSize" IS NULL AND "sha256Checksum" IS NULL AND "durationMs" IS NULL)
);

CREATE TABLE "migration_runs" (
  "id" UUID NOT NULL,
  "sourceSha256" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "summary" JSONB,
  CONSTRAINT "migration_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "migration_issues" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "sourceTable" TEXT NOT NULL,
  "sourceLegacyId" INTEGER,
  "field" TEXT NOT NULL,
  "severity" "MigrationIssueSeverity" NOT NULL,
  "problem" TEXT NOT NULL,
  "evidence" TEXT,
  "proposedAction" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "migration_issues_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "migration_runs_sourceSha256_idx" ON "migration_runs"("sourceSha256");
CREATE INDEX "migration_issues_runId_severity_idx" ON "migration_issues"("runId", "severity");
CREATE INDEX "migration_issues_sourceTable_sourceLegacyId_idx" ON "migration_issues"("sourceTable", "sourceLegacyId");
ALTER TABLE "migration_issues" ADD CONSTRAINT "migration_issues_runId_fkey" FOREIGN KEY ("runId") REFERENCES "migration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_media_asset_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW."sourceStorageKey" IS DISTINCT FROM OLD."sourceStorageKey"
    OR NEW."compatibilityFilename" IS DISTINCT FROM OLD."compatibilityFilename"
    OR NEW."legacyAudioId" IS DISTINCT FROM OLD."legacyAudioId" THEN
    RAISE EXCEPTION 'media storage identity is immutable';
  END IF;
  IF OLD.status IN ('READY', 'EXTERNAL') AND (
    NEW.kind IS DISTINCT FROM OLD.kind OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType" OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
    OR NEW."sha256Checksum" IS DISTINCT FROM OLD."sha256Checksum"
    OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height
    OR NEW."durationMs" IS DISTINCT FROM OLD."durationMs"
  ) THEN RAISE EXCEPTION 'verified or external media metadata is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
