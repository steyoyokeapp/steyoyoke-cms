-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ArtistStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'EDIT', 'PUBLISH', 'SCHEDULE', 'CANCEL_SCHEDULE', 'UNPUBLISH', 'ARCHIVE', 'RESTORE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "refreshTokenExpiresAt" TIMESTAMPTZ(6),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artists" (
    "id" UUID NOT NULL,
    "legacyId" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "shortBio" TEXT,
    "facebookUrl" TEXT,
    "status" "ArtistStatus" NOT NULL DEFAULT 'DRAFT',
    "workingVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedRevisionId" UUID,
    "scheduledRevisionId" UUID,
    "scheduledFor" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "artists_pkey" PRIMARY KEY ("id")
);

-- Legacy ids are allocated by PostgreSQL, start above the imported legacy range
-- locally, and can be advanced during import without changing application code.
ALTER SEQUENCE "artists_legacyId_seq" RENAME TO "legacy_artist_id_seq";
ALTER SEQUENCE "legacy_artist_id_seq" RESTART WITH 400;

ALTER TABLE "artists"
    ADD CONSTRAINT "artists_legacy_id_positive" CHECK ("legacyId" > 0),
    ADD CONSTRAINT "artists_working_version_positive" CHECK ("workingVersion" > 0),
    ADD CONSTRAINT "artists_name_not_blank" CHECK (btrim("name") <> ''),
    ADD CONSTRAINT "artists_slug_normalized" CHECK (
        "slug" = lower("slug")
        AND "slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    ),
    ADD CONSTRAINT "artists_schedule_fields_consistent" CHECK (
        ("status" = 'SCHEDULED' AND "scheduledRevisionId" IS NOT NULL AND "scheduledFor" IS NOT NULL)
        OR
        ("status" <> 'SCHEDULED' AND "scheduledRevisionId" IS NULL AND "scheduledFor" IS NULL)
    ),
    ADD CONSTRAINT "artists_published_pointer_required" CHECK (
        "status" <> 'PUBLISHED' OR "publishedRevisionId" IS NOT NULL
    );

-- CreateTable
CREATE TABLE "artist_revisions" (
    "id" UUID NOT NULL,
    "artistId" UUID NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "sourceWorkingVersion" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "shortBio" TEXT,
    "facebookUrl" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artist_revisions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "artist_revisions"
    ADD CONSTRAINT "artist_revisions_revision_number_positive" CHECK ("revisionNumber" > 0),
    ADD CONSTRAINT "artist_revisions_source_version_positive" CHECK ("sourceWorkingVersion" > 0),
    ADD CONSTRAINT "artist_revisions_name_not_blank" CHECK (btrim("name") <> ''),
    ADD CONSTRAINT "artist_revisions_slug_normalized" CHECK (
        "slug" = lower("slug")
        AND "slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    );

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "artistId" UUID NOT NULL,
    "actorId" UUID,
    "action" "AuditAction" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "artists_legacyId_key" ON "artists"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "artists_slug_key" ON "artists"("slug");

-- Defense in depth if a future writer stops canonicalizing slug case.
CREATE UNIQUE INDEX "artists_slug_normalized_key" ON "artists" (lower("slug"));

-- CreateIndex
CREATE INDEX "artists_status_idx" ON "artists"("status");

-- CreateIndex
CREATE INDEX "artists_scheduledFor_idx" ON "artists"("scheduledFor");

-- CreateIndex
CREATE INDEX "artist_revisions_createdById_idx" ON "artist_revisions"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "artist_revisions_artistId_revisionNumber_key" ON "artist_revisions"("artistId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "artist_revisions_artistId_id_key" ON "artist_revisions"("artistId", "id");

-- CreateIndex
CREATE INDEX "audit_logs_artistId_createdAt_idx" ON "audit_logs"("artistId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artists" ADD CONSTRAINT "artists_publishedRevision_ownership_fkey" FOREIGN KEY ("id", "publishedRevisionId") REFERENCES "artist_revisions"("artistId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artists" ADD CONSTRAINT "artists_scheduledRevision_ownership_fkey" FOREIGN KEY ("id", "scheduledRevisionId") REFERENCES "artist_revisions"("artistId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artist_revisions" ADD CONSTRAINT "artist_revisions_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artist_revisions" ADD CONSTRAINT "artist_revisions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Published and scheduled snapshots are append-only evidence. Both modification
-- and deletion are rejected at the database boundary.
CREATE FUNCTION prevent_artist_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'artist revisions are immutable';
END;
$$;

CREATE TRIGGER artist_revisions_immutable
BEFORE UPDATE OR DELETE ON "artist_revisions"
FOR EACH ROW EXECUTE FUNCTION prevent_artist_revision_mutation();
