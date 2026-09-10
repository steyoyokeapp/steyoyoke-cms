ALTER TYPE "MediaKind" ADD VALUE 'AUDIO';

ALTER TABLE "media_assets"
  ALTER COLUMN "compatibilityFilename" DROP NOT NULL,
  ALTER COLUMN "width" DROP NOT NULL,
  ALTER COLUMN "height" DROP NOT NULL,
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "legacyAudioId" TEXT;

ALTER TABLE "tracks" ADD COLUMN "audioAssetId" UUID;
ALTER TABLE "track_revisions" ADD COLUMN "audioAssetId" UUID;
ALTER TABLE "podcast_episodes" ADD COLUMN "audioAssetId" UUID;
ALTER TABLE "podcast_episode_revisions" ADD COLUMN "audioAssetId" UUID;

CREATE UNIQUE INDEX "media_assets_legacyAudioId_key" ON "media_assets"("legacyAudioId");
CREATE INDEX "tracks_audioAssetId_idx" ON "tracks"("audioAssetId");
CREATE INDEX "track_revisions_audioAssetId_idx" ON "track_revisions"("audioAssetId");
CREATE INDEX "podcast_episodes_audioAssetId_idx" ON "podcast_episodes"("audioAssetId");
CREATE INDEX "podcast_episode_revisions_audioAssetId_idx" ON "podcast_episode_revisions"("audioAssetId");

ALTER TABLE "tracks" ADD CONSTRAINT "tracks_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "track_revisions" ADD CONSTRAINT "track_revisions_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "podcast_episode_revisions" ADD CONSTRAINT "podcast_episode_revisions_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_media_asset_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW."sourceStorageKey" IS DISTINCT FROM OLD."sourceStorageKey"
    OR NEW."compatibilityFilename" IS DISTINCT FROM OLD."compatibilityFilename"
    OR NEW."legacyAudioId" IS DISTINCT FROM OLD."legacyAudioId" THEN
    RAISE EXCEPTION 'media storage identity is immutable';
  END IF;
  IF OLD.status = 'READY' AND (
    NEW.kind IS DISTINCT FROM OLD.kind OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType" OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
    OR NEW."sha256Checksum" IS DISTINCT FROM OLD."sha256Checksum"
    OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height
    OR NEW."durationMs" IS DISTINCT FROM OLD."durationMs"
  ) THEN RAISE EXCEPTION 'ready media metadata is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
