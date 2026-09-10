-- CreateEnum
CREATE TYPE "TrackStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "labels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "legacyValue" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracks" (
    "id" UUID NOT NULL,
    "legacyId" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "primaryArtistId" UUID NOT NULL,
    "secondaryArtistId" UUID,
    "labelId" UUID NOT NULL,
    "durationMs" INTEGER,
    "spotifyUrl" TEXT,
    "beatportUrl" TEXT,
    "traxsourceUrl" TEXT,
    "bandcampUrl" TEXT,
    "appleMusicUrl" TEXT,
    "soundcloudUrl" TEXT,
    "status" "TrackStatus" NOT NULL DEFAULT 'DRAFT',
    "workingVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedRevisionId" UUID,
    "scheduledRevisionId" UUID,
    "scheduledFor" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- Track and the future PodcastEpisode model intentionally allocate from one
-- non-recycling legacy namespace. 3336 is the audited imported high-water mark.
ALTER SEQUENCE "tracks_legacyId_seq" RENAME TO "legacy_track_id_seq";
ALTER SEQUENCE "legacy_track_id_seq" START WITH 3337 RESTART WITH 3337;

-- CreateTable
CREATE TABLE "track_revisions" (
    "id" UUID NOT NULL,
    "trackId" UUID NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "sourceWorkingVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "primaryArtistId" UUID NOT NULL,
    "primaryArtistLegacyId" INTEGER NOT NULL,
    "primaryArtistName" TEXT NOT NULL,
    "secondaryArtistId" UUID,
    "secondaryArtistLegacyId" INTEGER,
    "secondaryArtistName" TEXT,
    "labelId" UUID NOT NULL,
    "labelName" TEXT NOT NULL,
    "labelLegacyValue" TEXT NOT NULL,
    "durationMs" INTEGER,
    "spotifyUrl" TEXT,
    "beatportUrl" TEXT,
    "traxsourceUrl" TEXT,
    "bandcampUrl" TEXT,
    "appleMusicUrl" TEXT,
    "soundcloudUrl" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_audit_logs" (
    "id" UUID NOT NULL,
    "trackId" UUID NOT NULL,
    "actorId" UUID,
    "action" "AuditAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_audit_logs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "labels"
    ADD CONSTRAINT "labels_name_not_blank" CHECK (btrim("name") <> ''),
    ADD CONSTRAINT "labels_slug_not_blank" CHECK (btrim("slug") <> ''),
    ADD CONSTRAINT "labels_legacy_value_not_blank" CHECK (btrim("legacyValue") <> '');

ALTER TABLE "tracks"
    ADD CONSTRAINT "tracks_legacy_id_positive" CHECK ("legacyId" > 0),
    ADD CONSTRAINT "tracks_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "tracks_working_version_positive" CHECK ("workingVersion" > 0),
    ADD CONSTRAINT "tracks_duration_nonnegative" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
    ADD CONSTRAINT "tracks_artists_distinct" CHECK ("secondaryArtistId" IS NULL OR "primaryArtistId" <> "secondaryArtistId"),
    ADD CONSTRAINT "tracks_schedule_fields_consistent" CHECK (
      ("status" = 'SCHEDULED' AND "scheduledRevisionId" IS NOT NULL AND "scheduledFor" IS NOT NULL)
      OR ("status" <> 'SCHEDULED' AND "scheduledRevisionId" IS NULL AND "scheduledFor" IS NULL)
    ),
    ADD CONSTRAINT "tracks_published_pointer_required" CHECK (
      "status" NOT IN ('PUBLISHED', 'SCHEDULED') OR "publishedRevisionId" IS NOT NULL OR "status" = 'SCHEDULED'
    ),
    ADD CONSTRAINT "tracks_urls_https" CHECK (
      ("spotifyUrl" IS NULL OR "spotifyUrl" ~ '^https://[^[:space:]]+$') AND
      ("beatportUrl" IS NULL OR "beatportUrl" ~ '^https://[^[:space:]]+$') AND
      ("traxsourceUrl" IS NULL OR "traxsourceUrl" ~ '^https://[^[:space:]]+$') AND
      ("bandcampUrl" IS NULL OR "bandcampUrl" ~ '^https://[^[:space:]]+$') AND
      ("appleMusicUrl" IS NULL OR "appleMusicUrl" ~ '^https://[^[:space:]]+$') AND
      ("soundcloudUrl" IS NULL OR "soundcloudUrl" ~ '^https://[^[:space:]]+$')
    );

ALTER TABLE "track_revisions"
    ADD CONSTRAINT "track_revisions_number_positive" CHECK ("revisionNumber" > 0),
    ADD CONSTRAINT "track_revisions_source_version_positive" CHECK ("sourceWorkingVersion" > 0),
    ADD CONSTRAINT "track_revisions_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "track_revisions_duration_nonnegative" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
    ADD CONSTRAINT "track_revisions_artists_distinct" CHECK ("secondaryArtistId" IS NULL OR "primaryArtistId" <> "secondaryArtistId"),
    ADD CONSTRAINT "track_revisions_urls_https" CHECK (
      ("spotifyUrl" IS NULL OR "spotifyUrl" ~ '^https://[^[:space:]]+$') AND
      ("beatportUrl" IS NULL OR "beatportUrl" ~ '^https://[^[:space:]]+$') AND
      ("traxsourceUrl" IS NULL OR "traxsourceUrl" ~ '^https://[^[:space:]]+$') AND
      ("bandcampUrl" IS NULL OR "bandcampUrl" ~ '^https://[^[:space:]]+$') AND
      ("appleMusicUrl" IS NULL OR "appleMusicUrl" ~ '^https://[^[:space:]]+$') AND
      ("soundcloudUrl" IS NULL OR "soundcloudUrl" ~ '^https://[^[:space:]]+$')
    );

CREATE FUNCTION reject_track_revision_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'track revisions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER track_revisions_immutable
BEFORE UPDATE OR DELETE ON "track_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_track_revision_mutation();

CREATE FUNCTION reject_track_legacy_id_change() RETURNS trigger AS $$
BEGIN
    IF NEW."legacyId" <> OLD."legacyId" THEN
        RAISE EXCEPTION 'legacy track ids are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tracks_legacy_id_immutable
BEFORE UPDATE OF "legacyId" ON "tracks"
FOR EACH ROW EXECUTE FUNCTION reject_track_legacy_id_change();

CREATE FUNCTION reject_label_legacy_value_change() RETURNS trigger AS $$
BEGIN
    IF NEW."legacyValue" <> OLD."legacyValue" THEN
        RAISE EXCEPTION 'label legacy values are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER labels_legacy_value_immutable
BEFORE UPDATE OF "legacyValue" ON "labels"
FOR EACH ROW EXECUTE FUNCTION reject_label_legacy_value_change();

-- CreateIndex
CREATE UNIQUE INDEX "labels_slug_key" ON "labels"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "labels_legacyValue_key" ON "labels"("legacyValue");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_legacyId_key" ON "tracks"("legacyId");

-- CreateIndex
CREATE INDEX "tracks_primaryArtistId_idx" ON "tracks"("primaryArtistId");

-- CreateIndex
CREATE INDEX "tracks_secondaryArtistId_idx" ON "tracks"("secondaryArtistId");

-- CreateIndex
CREATE INDEX "tracks_labelId_idx" ON "tracks"("labelId");

-- CreateIndex
CREATE INDEX "tracks_status_idx" ON "tracks"("status");

-- CreateIndex
CREATE INDEX "tracks_scheduledFor_idx" ON "tracks"("scheduledFor");

-- CreateIndex
CREATE INDEX "track_revisions_primaryArtistId_idx" ON "track_revisions"("primaryArtistId");

-- CreateIndex
CREATE INDEX "track_revisions_secondaryArtistId_idx" ON "track_revisions"("secondaryArtistId");

-- CreateIndex
CREATE INDEX "track_revisions_labelId_idx" ON "track_revisions"("labelId");

-- CreateIndex
CREATE INDEX "track_revisions_createdById_idx" ON "track_revisions"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "track_revisions_trackId_revisionNumber_key" ON "track_revisions"("trackId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "track_revisions_trackId_id_key" ON "track_revisions"("trackId", "id");

-- CreateIndex
CREATE INDEX "track_audit_logs_trackId_createdAt_idx" ON "track_audit_logs"("trackId", "createdAt");

-- CreateIndex
CREATE INDEX "track_audit_logs_actorId_idx" ON "track_audit_logs"("actorId");

-- RenameForeignKey
ALTER TABLE "artists" RENAME CONSTRAINT "artists_publishedRevision_ownership_fkey" TO "artists_id_publishedRevisionId_fkey";

-- RenameForeignKey
ALTER TABLE "artists" RENAME CONSTRAINT "artists_scheduledRevision_ownership_fkey" TO "artists_id_scheduledRevisionId_fkey";

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_primaryArtistId_fkey" FOREIGN KEY ("primaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_secondaryArtistId_fkey" FOREIGN KEY ("secondaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_id_publishedRevisionId_fkey" FOREIGN KEY ("id", "publishedRevisionId") REFERENCES "track_revisions"("trackId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_id_scheduledRevisionId_fkey" FOREIGN KEY ("id", "scheduledRevisionId") REFERENCES "track_revisions"("trackId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_revisions" ADD CONSTRAINT "track_revisions_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_revisions" ADD CONSTRAINT "track_revisions_primaryArtistId_fkey" FOREIGN KEY ("primaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_revisions" ADD CONSTRAINT "track_revisions_secondaryArtistId_fkey" FOREIGN KEY ("secondaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_revisions" ADD CONSTRAINT "track_revisions_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_revisions" ADD CONSTRAINT "track_revisions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_audit_logs" ADD CONSTRAINT "track_audit_logs_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_audit_logs" ADD CONSTRAINT "track_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
