# Phase 11 catalogue migration rehearsal

This tooling is a local, repeatable rehearsal. It never connects to legacy MySQL, AWS, S3, or production PostgreSQL. The extractor reads only `artists`, `tracks`, `releases`, and `release_tracks` INSERT statements from the immutable SQL snapshot. Authentication, account, session, password, and device-token tables are not parsed.

## Safety boundaries

- The target host must be `localhost`, `127.0.0.1`, or `::1`.
- The target database name is always rewritten and checked as `steyoyoke_cms_migration_rehearsal`.
- Rehearsal reset drops and recreates only the `public` schema inside that dedicated database.
- The legacy SQL and FTP snapshots are read-only inputs.
- Generated media and detailed reports live in `.migration-rehearsal/`, which is Git-ignored.
- The normal development and test databases are not rehearsal targets.

Create the dedicated database once if the application role cannot create databases:

```sh
createdb -O steyoyoke_cms steyoyoke_cms_migration_rehearsal
```

Set `MIGRATION_REHEARSAL_DATABASE_URL` when the rehearsal database does not share the credentials in `DATABASE_URL`. The tool still forces the database name to the dedicated name.

## Commands

```sh
npm run migration:analyze
npm run migration:rehearse
npm run migration:compare
npm run migration:report
npm run migration:manifest
```

`analyze` parses and classifies the source without a database write. `rehearse` resets the dedicated schema, applies all Prisma migrations, regenerates local canonical image variants, imports valid content and initial immutable revisions, advances legacy-ID sequences, and persists sanitized issues. `compare` projects the imported revisions through the new legacy serializers across the full imported catalogue and verifies local image storage paths. `report` prints only aggregate quality and comparison results. `manifest` writes the deterministic migration freeze manifest from the completed report and comparison.

## Mapping policy

- Artist and Release legacy IDs remain in their dedicated numeric namespaces.
- legacy `tracks.type` deterministically splits into canonical Track and PodcastEpisode while preserving their shared numeric namespace.
- Only `STEYOYOKE`, `STEYOYOKE_BLACK`, and `INNER_SYMPHONY` map to approved Labels.
- Blank or malformed required values block that record. Ambiguous values are not invented.
- Legacy HTTP URLs normalize to HTTPS and malformed URLs become `null`; both remain visible in migration issues.
- A missing secondary Artist is omitted with a warning. A duplicate primary/secondary reference is omitted as a compatibility normalization.
- Valid local original artwork is decoded and regenerated into the canonical six-variant set. Broken derivative path columns are not trusted.
- Malformed Podcast chapter lines are retained as issue evidence and are not forced into canonical chapters.
- Valid ReleaseTrack rows keep legacy priority as canonical position. Dangling or duplicate relations are omitted rather than creating fake content.

## Historical audio design

Historical audio has an exact legacy `file_id`, but no local binary and S3 access is prohibited. `MediaProvider.LEGACY_EXTERNAL` plus `MediaStatus.EXTERNAL` represents this state without fabricating a READY file. Binary metadata remains null under a database check constraint, and storage identity is immutable.

Track legacy projection returns the exact raw `legacyAudioId`. Podcast projection builds the established compatibility URL from that exact encoded ID. Normal CMS publication gates continue to require `READY` local audio, so an imported external reference must be progressively materialized and verified before an editor can republish it.

## Publication and idempotency

Valid historical live records are inserted as DRAFT, receive revision 1, then receive the immutable published pointer and PUBLISHED status. Release revisions freeze exact TrackRevision IDs through ReleaseRevisionTrack. Deterministic UUIDs derive from entity scope plus legacy identity.

Repeatability is verified by running `migration:rehearse` twice from a wiped dedicated schema and comparing logical summaries and order-independent comparison results. Generated timestamps are intentionally excluded from equality.

The comparison runs through the new compatibility serializer layer against source-equivalent projections extracted from the immutable dump. A live local legacy HTTP clone was not required or contacted; Phase 12 should add route-level golden fixtures if exact local-clone HTTP responses become available.
