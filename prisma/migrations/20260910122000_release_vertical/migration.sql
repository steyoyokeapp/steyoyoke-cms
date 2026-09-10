-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'TRACKS_EDIT';
ALTER TYPE "AuditAction" ADD VALUE 'REORDER';

-- CreateTable
CREATE TABLE "releases" (
    "id" UUID NOT NULL,
    "legacyId" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "primaryArtistId" UUID NOT NULL,
    "secondaryArtistId" UUID,
    "releaseDate" DATE,
    "labelId" UUID NOT NULL,
    "spotifyUrl" TEXT,
    "beatportUrl" TEXT,
    "traxsourceUrl" TEXT,
    "bandcampUrl" TEXT,
    "appleMusicUrl" TEXT,
    "soundcloudUrl" TEXT,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT',
    "workingVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedRevisionId" UUID,
    "scheduledRevisionId" UUID,
    "scheduledFor" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- Release IDs have their own audited legacy namespace. 648 is the imported
-- production high-water mark; application code only relies on the sequence.
ALTER SEQUENCE "releases_legacyId_seq" RENAME TO "legacy_release_id_seq";
ALTER SEQUENCE "legacy_release_id_seq" START WITH 649 RESTART WITH 649;

-- CreateTable
CREATE TABLE "release_tracks" (
    "id" UUID NOT NULL,
    "releaseId" UUID NOT NULL,
    "trackId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "release_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_revisions" (
    "id" UUID NOT NULL,
    "releaseId" UUID NOT NULL,
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
    "releaseDate" DATE NOT NULL,
    "spotifyUrl" TEXT,
    "beatportUrl" TEXT,
    "traxsourceUrl" TEXT,
    "bandcampUrl" TEXT,
    "appleMusicUrl" TEXT,
    "soundcloudUrl" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_revision_tracks" (
    "id" UUID NOT NULL,
    "releaseRevisionId" UUID NOT NULL,
    "trackRevisionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "release_revision_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_audit_logs" (
    "id" UUID NOT NULL,
    "releaseId" UUID NOT NULL,
    "actorId" UUID,
    "action" "AuditAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_audit_logs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "releases"
    ADD CONSTRAINT "releases_legacy_id_positive" CHECK ("legacyId" > 0),
    ADD CONSTRAINT "releases_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "releases_working_version_positive" CHECK ("workingVersion" > 0),
    ADD CONSTRAINT "releases_artists_distinct" CHECK ("secondaryArtistId" IS NULL OR "primaryArtistId" <> "secondaryArtistId"),
    ADD CONSTRAINT "releases_schedule_fields_consistent" CHECK (
      ("status" = 'SCHEDULED' AND "scheduledRevisionId" IS NOT NULL AND "scheduledFor" IS NOT NULL)
      OR ("status" <> 'SCHEDULED' AND "scheduledRevisionId" IS NULL AND "scheduledFor" IS NULL)
    ),
    ADD CONSTRAINT "releases_published_pointer_required" CHECK (
      "status" NOT IN ('PUBLISHED', 'SCHEDULED') OR "publishedRevisionId" IS NOT NULL OR "status" = 'SCHEDULED'
    ),
    ADD CONSTRAINT "releases_urls_https" CHECK (
      ("spotifyUrl" IS NULL OR "spotifyUrl" ~ '^https://[^[:space:]]+$') AND
      ("beatportUrl" IS NULL OR "beatportUrl" ~ '^https://[^[:space:]]+$') AND
      ("traxsourceUrl" IS NULL OR "traxsourceUrl" ~ '^https://[^[:space:]]+$') AND
      ("bandcampUrl" IS NULL OR "bandcampUrl" ~ '^https://[^[:space:]]+$') AND
      ("appleMusicUrl" IS NULL OR "appleMusicUrl" ~ '^https://[^[:space:]]+$') AND
      ("soundcloudUrl" IS NULL OR "soundcloudUrl" ~ '^https://[^[:space:]]+$')
    );

ALTER TABLE "release_tracks"
    ADD CONSTRAINT "release_tracks_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "release_revisions"
    ADD CONSTRAINT "release_revisions_number_positive" CHECK ("revisionNumber" > 0),
    ADD CONSTRAINT "release_revisions_source_version_positive" CHECK ("sourceWorkingVersion" > 0),
    ADD CONSTRAINT "release_revisions_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "release_revisions_artists_distinct" CHECK ("secondaryArtistId" IS NULL OR "primaryArtistId" <> "secondaryArtistId"),
    ADD CONSTRAINT "release_revisions_urls_https" CHECK (
      ("spotifyUrl" IS NULL OR "spotifyUrl" ~ '^https://[^[:space:]]+$') AND
      ("beatportUrl" IS NULL OR "beatportUrl" ~ '^https://[^[:space:]]+$') AND
      ("traxsourceUrl" IS NULL OR "traxsourceUrl" ~ '^https://[^[:space:]]+$') AND
      ("bandcampUrl" IS NULL OR "bandcampUrl" ~ '^https://[^[:space:]]+$') AND
      ("appleMusicUrl" IS NULL OR "appleMusicUrl" ~ '^https://[^[:space:]]+$') AND
      ("soundcloudUrl" IS NULL OR "soundcloudUrl" ~ '^https://[^[:space:]]+$')
    );

ALTER TABLE "release_revision_tracks"
    ADD CONSTRAINT "release_revision_tracks_position_nonnegative" CHECK ("position" >= 0);

CREATE FUNCTION reject_release_revision_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'release revisions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER release_revisions_immutable
BEFORE UPDATE OR DELETE ON "release_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_release_revision_mutation();

CREATE FUNCTION reject_release_revision_track_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'release revision tracks are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER release_revision_tracks_immutable
BEFORE UPDATE OR DELETE ON "release_revision_tracks"
FOR EACH ROW EXECUTE FUNCTION reject_release_revision_track_mutation();

CREATE FUNCTION reject_release_legacy_id_change() RETURNS trigger AS $$
BEGIN
    IF NEW."legacyId" <> OLD."legacyId" THEN
        RAISE EXCEPTION 'legacy release ids are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER releases_legacy_id_immutable
BEFORE UPDATE OF "legacyId" ON "releases"
FOR EACH ROW EXECUTE FUNCTION reject_release_legacy_id_change();

CREATE UNIQUE INDEX "releases_legacyId_key" ON "releases"("legacyId");
CREATE INDEX "releases_primaryArtistId_idx" ON "releases"("primaryArtistId");
CREATE INDEX "releases_secondaryArtistId_idx" ON "releases"("secondaryArtistId");
CREATE INDEX "releases_labelId_idx" ON "releases"("labelId");
CREATE INDEX "releases_releaseDate_idx" ON "releases"("releaseDate");
CREATE INDEX "releases_status_idx" ON "releases"("status");
CREATE INDEX "releases_scheduledFor_idx" ON "releases"("scheduledFor");
CREATE INDEX "release_tracks_trackId_idx" ON "release_tracks"("trackId");
CREATE UNIQUE INDEX "release_tracks_releaseId_trackId_key" ON "release_tracks"("releaseId", "trackId");
CREATE UNIQUE INDEX "release_tracks_releaseId_position_key" ON "release_tracks"("releaseId", "position");
CREATE INDEX "release_revisions_primaryArtistId_idx" ON "release_revisions"("primaryArtistId");
CREATE INDEX "release_revisions_secondaryArtistId_idx" ON "release_revisions"("secondaryArtistId");
CREATE INDEX "release_revisions_labelId_idx" ON "release_revisions"("labelId");
CREATE INDEX "release_revisions_createdById_idx" ON "release_revisions"("createdById");
CREATE UNIQUE INDEX "release_revisions_releaseId_revisionNumber_key" ON "release_revisions"("releaseId", "revisionNumber");
CREATE UNIQUE INDEX "release_revisions_releaseId_id_key" ON "release_revisions"("releaseId", "id");
CREATE INDEX "release_revision_tracks_trackRevisionId_idx" ON "release_revision_tracks"("trackRevisionId");
CREATE UNIQUE INDEX "release_revision_tracks_releaseRevisionId_trackRevisionId_key" ON "release_revision_tracks"("releaseRevisionId", "trackRevisionId");
CREATE UNIQUE INDEX "release_revision_tracks_releaseRevisionId_position_key" ON "release_revision_tracks"("releaseRevisionId", "position");
CREATE INDEX "release_audit_logs_releaseId_createdAt_idx" ON "release_audit_logs"("releaseId", "createdAt");
CREATE INDEX "release_audit_logs_actorId_idx" ON "release_audit_logs"("actorId");

ALTER TABLE "releases" ADD CONSTRAINT "releases_primaryArtistId_fkey" FOREIGN KEY ("primaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "releases" ADD CONSTRAINT "releases_secondaryArtistId_fkey" FOREIGN KEY ("secondaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "releases" ADD CONSTRAINT "releases_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "releases" ADD CONSTRAINT "releases_id_publishedRevisionId_fkey" FOREIGN KEY ("id", "publishedRevisionId") REFERENCES "release_revisions"("releaseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "releases" ADD CONSTRAINT "releases_id_scheduledRevisionId_fkey" FOREIGN KEY ("id", "scheduledRevisionId") REFERENCES "release_revisions"("releaseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_tracks" ADD CONSTRAINT "release_tracks_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_tracks" ADD CONSTRAINT "release_tracks_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_revisions" ADD CONSTRAINT "release_revisions_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_revisions" ADD CONSTRAINT "release_revisions_primaryArtistId_fkey" FOREIGN KEY ("primaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_revisions" ADD CONSTRAINT "release_revisions_secondaryArtistId_fkey" FOREIGN KEY ("secondaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_revisions" ADD CONSTRAINT "release_revisions_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_revisions" ADD CONSTRAINT "release_revisions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_revision_tracks" ADD CONSTRAINT "release_revision_tracks_releaseRevisionId_fkey" FOREIGN KEY ("releaseRevisionId") REFERENCES "release_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_revision_tracks" ADD CONSTRAINT "release_revision_tracks_trackRevisionId_fkey" FOREIGN KEY ("trackRevisionId") REFERENCES "track_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_audit_logs" ADD CONSTRAINT "release_audit_logs_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_audit_logs" ADD CONSTRAINT "release_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
