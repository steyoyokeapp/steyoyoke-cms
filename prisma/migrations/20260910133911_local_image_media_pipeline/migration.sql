-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED', 'RETIRED');

-- CreateEnum
CREATE TYPE "MediaVariantKey" AS ENUM ('ORIGINAL', 'LEGACY_1440', 'LEGACY_1024', 'LEGACY_512', 'LEGACY_THUMB_256', 'LEGACY_THUMB_80');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_UPLOAD';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ATTACH';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_REPLACE';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_DETACH';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_RETIRE';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_PURGE';

-- AlterTable
ALTER TABLE "artist_revisions" ADD COLUMN     "imageAssetId" UUID;

-- AlterTable
ALTER TABLE "artists" ADD COLUMN     "imageAssetId" UUID;

-- AlterTable
ALTER TABLE "podcast_episode_revisions" ADD COLUMN     "artworkAssetId" UUID;

-- AlterTable
ALTER TABLE "podcast_episodes" ADD COLUMN     "artworkAssetId" UUID;

-- AlterTable
ALTER TABLE "release_revisions" ADD COLUMN     "artworkAssetId" UUID;

-- AlterTable
ALTER TABLE "releases" ADD COLUMN     "artworkAssetId" UUID;

-- AlterTable
ALTER TABLE "track_revisions" ADD COLUMN     "artworkAssetId" UUID;

-- AlterTable
ALTER TABLE "tracks" ADD COLUMN     "artworkAssetId" UUID;

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL DEFAULT 'IMAGE',
    "status" "MediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "provider" TEXT NOT NULL DEFAULT 'LOCAL',
    "sourceStorageKey" TEXT NOT NULL,
    "compatibilityFilename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256Checksum" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "failureReason" TEXT,
    "unreferencedAt" TIMESTAMPTZ(6),
    "retiredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_variants" (
    "id" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "variantKey" "MediaVariantKey" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256Checksum" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_audit_logs" (
    "id" UUID NOT NULL,
    "mediaAssetId" UUID,
    "actorId" UUID,
    "action" "AuditAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_sourceStorageKey_key" ON "media_assets"("sourceStorageKey");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_compatibilityFilename_key" ON "media_assets"("compatibilityFilename");

-- CreateIndex
CREATE INDEX "media_assets_status_createdAt_idx" ON "media_assets"("status", "createdAt");

-- CreateIndex
CREATE INDEX "media_assets_unreferencedAt_idx" ON "media_assets"("unreferencedAt");

-- CreateIndex
CREATE INDEX "media_assets_createdById_idx" ON "media_assets"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "media_variants_storageKey_key" ON "media_variants"("storageKey");

-- CreateIndex
CREATE INDEX "media_variants_mediaAssetId_idx" ON "media_variants"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "media_variants_mediaAssetId_variantKey_key" ON "media_variants"("mediaAssetId", "variantKey");

-- CreateIndex
CREATE INDEX "media_audit_logs_mediaAssetId_createdAt_idx" ON "media_audit_logs"("mediaAssetId", "createdAt");

-- CreateIndex
CREATE INDEX "media_audit_logs_actorId_idx" ON "media_audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "artist_revisions_imageAssetId_idx" ON "artist_revisions"("imageAssetId");

-- CreateIndex
CREATE INDEX "artists_imageAssetId_idx" ON "artists"("imageAssetId");

-- CreateIndex
CREATE INDEX "podcast_episode_revisions_artworkAssetId_idx" ON "podcast_episode_revisions"("artworkAssetId");

-- CreateIndex
CREATE INDEX "podcast_episodes_artworkAssetId_idx" ON "podcast_episodes"("artworkAssetId");

-- CreateIndex
CREATE INDEX "release_revisions_artworkAssetId_idx" ON "release_revisions"("artworkAssetId");

-- CreateIndex
CREATE INDEX "releases_artworkAssetId_idx" ON "releases"("artworkAssetId");

-- CreateIndex
CREATE INDEX "track_revisions_artworkAssetId_idx" ON "track_revisions"("artworkAssetId");

-- CreateIndex
CREATE INDEX "tracks_artworkAssetId_idx" ON "tracks"("artworkAssetId");

-- AddForeignKey
ALTER TABLE "artists" ADD CONSTRAINT "artists_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artist_revisions" ADD CONSTRAINT "artist_revisions_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artworkAssetId_fkey" FOREIGN KEY ("artworkAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_revisions" ADD CONSTRAINT "track_revisions_artworkAssetId_fkey" FOREIGN KEY ("artworkAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_artworkAssetId_fkey" FOREIGN KEY ("artworkAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episode_revisions" ADD CONSTRAINT "podcast_episode_revisions_artworkAssetId_fkey" FOREIGN KEY ("artworkAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_artworkAssetId_fkey" FOREIGN KEY ("artworkAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_revisions" ADD CONSTRAINT "release_revisions_artworkAssetId_fkey" FOREIGN KEY ("artworkAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_audit_logs" ADD CONSTRAINT "media_audit_logs_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_audit_logs" ADD CONSTRAINT "media_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
