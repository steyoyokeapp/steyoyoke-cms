-- Additive only: existing working records and frozen revisions remain NULL.
ALTER TABLE "releases" ADD COLUMN "catalogue" TEXT;
ALTER TABLE "release_revisions" ADD COLUMN "catalogue" TEXT;
