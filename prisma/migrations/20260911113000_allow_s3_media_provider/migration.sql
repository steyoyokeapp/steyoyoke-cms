ALTER TABLE "media_assets"
  DROP CONSTRAINT "media_assets_provider_integrity";

ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_provider_integrity" CHECK (
  ("provider" IN ('LOCAL', 'S3_COMPATIBLE') AND "sourceStorageKey" IS NOT NULL AND "originalFilename" IS NOT NULL
    AND "mimeType" IS NOT NULL AND "byteSize" IS NOT NULL AND "sha256Checksum" IS NOT NULL)
  OR
  ("provider" = 'LEGACY_EXTERNAL' AND "kind" = 'AUDIO' AND "status" = 'EXTERNAL'
    AND "legacyAudioId" IS NOT NULL AND "sourceStorageKey" IS NULL AND "mimeType" IS NULL
    AND "byteSize" IS NULL AND "sha256Checksum" IS NULL AND "durationMs" IS NULL)
);
