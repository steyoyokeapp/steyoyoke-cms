-- CreateEnum
CREATE TYPE "PodcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'CHAPTERS_EDIT';

-- CreateTable
CREATE TABLE "podcast_episodes" (
    "id" UUID NOT NULL,
    "legacyId" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "primaryArtistId" UUID NOT NULL,
    "secondaryArtistId" UUID,
    "labelId" UUID NOT NULL,
    "episodeDate" DATE,
    "durationMs" INTEGER,
    "status" "PodcastStatus" NOT NULL DEFAULT 'DRAFT',
    "workingVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedRevisionId" UUID,
    "scheduledRevisionId" UUID,
    "scheduledFor" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "podcast_episodes_pkey" PRIMARY KEY ("id")
);

-- PodcastEpisode joins Track's existing legacy namespace. The generated
-- Podcast-only sequence is deliberately discarded; both defaults call the
-- same non-recycling sequence.
ALTER TABLE "podcast_episodes"
    ALTER COLUMN "legacyId" SET DEFAULT nextval('legacy_track_id_seq'::regclass);
ALTER SEQUENCE "podcast_episodes_legacyId_seq" OWNED BY NONE;
DROP SEQUENCE "podcast_episodes_legacyId_seq";

-- CreateTable
CREATE TABLE "podcast_chapters" (
    "id" UUID NOT NULL,
    "episodeId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "artist" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "legacyReference" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "podcast_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "podcast_episode_revisions" (
    "id" UUID NOT NULL,
    "episodeId" UUID NOT NULL,
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
    "episodeDate" DATE NOT NULL,
    "durationMs" INTEGER,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "podcast_episode_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "podcast_chapter_revisions" (
    "id" UUID NOT NULL,
    "episodeRevisionId" UUID NOT NULL,
    "sourceChapterId" UUID,
    "position" INTEGER NOT NULL,
    "artist" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "legacyReference" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "podcast_chapter_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "podcast_audit_logs" (
    "id" UUID NOT NULL,
    "episodeId" UUID NOT NULL,
    "actorId" UUID,
    "action" "AuditAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "podcast_audit_logs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "podcast_episodes"
    ADD CONSTRAINT "podcast_episodes_legacy_id_positive" CHECK ("legacyId" > 0),
    ADD CONSTRAINT "podcast_episodes_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "podcast_episodes_working_version_positive" CHECK ("workingVersion" > 0),
    ADD CONSTRAINT "podcast_episodes_duration_nonnegative" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
    ADD CONSTRAINT "podcast_episodes_artists_distinct" CHECK ("secondaryArtistId" IS NULL OR "primaryArtistId" <> "secondaryArtistId"),
    ADD CONSTRAINT "podcast_episodes_schedule_fields_consistent" CHECK (
      ("status" = 'SCHEDULED' AND "scheduledRevisionId" IS NOT NULL AND "scheduledFor" IS NOT NULL)
      OR ("status" <> 'SCHEDULED' AND "scheduledRevisionId" IS NULL AND "scheduledFor" IS NULL)
    ),
    ADD CONSTRAINT "podcast_episodes_published_pointer_required" CHECK (
      "status" NOT IN ('PUBLISHED', 'SCHEDULED') OR "publishedRevisionId" IS NOT NULL OR "status" = 'SCHEDULED'
    );

ALTER TABLE "podcast_chapters"
    ADD CONSTRAINT "podcast_chapters_position_nonnegative" CHECK ("position" >= 0),
    ADD CONSTRAINT "podcast_chapters_artist_not_blank" CHECK (btrim("artist") <> ''),
    ADD CONSTRAINT "podcast_chapters_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "podcast_chapters_duration_nonnegative" CHECK ("durationMs" IS NULL OR "durationMs" >= 0);

ALTER TABLE "podcast_episode_revisions"
    ADD CONSTRAINT "podcast_episode_revisions_number_positive" CHECK ("revisionNumber" > 0),
    ADD CONSTRAINT "podcast_episode_revisions_source_version_positive" CHECK ("sourceWorkingVersion" > 0),
    ADD CONSTRAINT "podcast_episode_revisions_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "podcast_episode_revisions_duration_nonnegative" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
    ADD CONSTRAINT "podcast_episode_revisions_artists_distinct" CHECK ("secondaryArtistId" IS NULL OR "primaryArtistId" <> "secondaryArtistId");

ALTER TABLE "podcast_chapter_revisions"
    ADD CONSTRAINT "podcast_chapter_revisions_position_nonnegative" CHECK ("position" >= 0),
    ADD CONSTRAINT "podcast_chapter_revisions_artist_not_blank" CHECK (btrim("artist") <> ''),
    ADD CONSTRAINT "podcast_chapter_revisions_title_not_blank" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "podcast_chapter_revisions_duration_nonnegative" CHECK ("durationMs" IS NULL OR "durationMs" >= 0);

CREATE FUNCTION reject_podcast_revision_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'podcast episode revisions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER podcast_episode_revisions_immutable
BEFORE UPDATE OR DELETE ON "podcast_episode_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_podcast_revision_mutation();

CREATE FUNCTION reject_podcast_chapter_revision_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'podcast chapter revisions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER podcast_chapter_revisions_immutable
BEFORE UPDATE OR DELETE ON "podcast_chapter_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_podcast_chapter_revision_mutation();

CREATE FUNCTION reject_podcast_legacy_id_change() RETURNS trigger AS $$
BEGIN
    IF NEW."legacyId" <> OLD."legacyId" THEN
        RAISE EXCEPTION 'legacy podcast ids are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER podcast_episodes_legacy_id_immutable
BEFORE UPDATE OF "legacyId" ON "podcast_episodes"
FOR EACH ROW EXECUTE FUNCTION reject_podcast_legacy_id_change();

-- CreateIndex
CREATE UNIQUE INDEX "podcast_episodes_legacyId_key" ON "podcast_episodes"("legacyId");

-- CreateIndex
CREATE INDEX "podcast_episodes_primaryArtistId_idx" ON "podcast_episodes"("primaryArtistId");

-- CreateIndex
CREATE INDEX "podcast_episodes_secondaryArtistId_idx" ON "podcast_episodes"("secondaryArtistId");

-- CreateIndex
CREATE INDEX "podcast_episodes_labelId_idx" ON "podcast_episodes"("labelId");

-- CreateIndex
CREATE INDEX "podcast_episodes_episodeDate_idx" ON "podcast_episodes"("episodeDate");

-- CreateIndex
CREATE INDEX "podcast_episodes_status_idx" ON "podcast_episodes"("status");

-- CreateIndex
CREATE INDEX "podcast_episodes_scheduledFor_idx" ON "podcast_episodes"("scheduledFor");

-- CreateIndex
CREATE INDEX "podcast_chapters_episodeId_idx" ON "podcast_chapters"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "podcast_chapters_episodeId_position_key" ON "podcast_chapters"("episodeId", "position");

-- CreateIndex
CREATE INDEX "podcast_episode_revisions_primaryArtistId_idx" ON "podcast_episode_revisions"("primaryArtistId");

-- CreateIndex
CREATE INDEX "podcast_episode_revisions_secondaryArtistId_idx" ON "podcast_episode_revisions"("secondaryArtistId");

-- CreateIndex
CREATE INDEX "podcast_episode_revisions_labelId_idx" ON "podcast_episode_revisions"("labelId");

-- CreateIndex
CREATE INDEX "podcast_episode_revisions_createdById_idx" ON "podcast_episode_revisions"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "podcast_episode_revisions_episodeId_revisionNumber_key" ON "podcast_episode_revisions"("episodeId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "podcast_episode_revisions_episodeId_id_key" ON "podcast_episode_revisions"("episodeId", "id");

-- CreateIndex
CREATE INDEX "podcast_chapter_revisions_episodeRevisionId_idx" ON "podcast_chapter_revisions"("episodeRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "podcast_chapter_revisions_episodeRevisionId_position_key" ON "podcast_chapter_revisions"("episodeRevisionId", "position");

-- CreateIndex
CREATE INDEX "podcast_audit_logs_episodeId_createdAt_idx" ON "podcast_audit_logs"("episodeId", "createdAt");

-- CreateIndex
CREATE INDEX "podcast_audit_logs_actorId_idx" ON "podcast_audit_logs"("actorId");

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_primaryArtistId_fkey" FOREIGN KEY ("primaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_secondaryArtistId_fkey" FOREIGN KEY ("secondaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_id_publishedRevisionId_fkey" FOREIGN KEY ("id", "publishedRevisionId") REFERENCES "podcast_episode_revisions"("episodeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_id_scheduledRevisionId_fkey" FOREIGN KEY ("id", "scheduledRevisionId") REFERENCES "podcast_episode_revisions"("episodeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_chapters" ADD CONSTRAINT "podcast_chapters_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "podcast_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episode_revisions" ADD CONSTRAINT "podcast_episode_revisions_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "podcast_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episode_revisions" ADD CONSTRAINT "podcast_episode_revisions_primaryArtistId_fkey" FOREIGN KEY ("primaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episode_revisions" ADD CONSTRAINT "podcast_episode_revisions_secondaryArtistId_fkey" FOREIGN KEY ("secondaryArtistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episode_revisions" ADD CONSTRAINT "podcast_episode_revisions_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episode_revisions" ADD CONSTRAINT "podcast_episode_revisions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_chapter_revisions" ADD CONSTRAINT "podcast_chapter_revisions_episodeRevisionId_fkey" FOREIGN KEY ("episodeRevisionId") REFERENCES "podcast_episode_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_audit_logs" ADD CONSTRAINT "podcast_audit_logs_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "podcast_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_audit_logs" ADD CONSTRAINT "podcast_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
