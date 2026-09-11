ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_PROCESS';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_RETRY';

CREATE TYPE "MediaProcessingJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "media_processing_jobs" (
    "id" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "status" "MediaProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "media_processing_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_processing_jobs_mediaAssetId_key" ON "media_processing_jobs"("mediaAssetId");
CREATE INDEX "media_processing_jobs_status_availableAt_idx" ON "media_processing_jobs"("status", "availableAt");
CREATE INDEX "media_processing_jobs_lockedAt_idx" ON "media_processing_jobs"("lockedAt");

ALTER TABLE "media_processing_jobs" ADD CONSTRAINT "media_processing_jobs_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
