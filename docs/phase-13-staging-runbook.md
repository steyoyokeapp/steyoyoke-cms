# Phase 13 staging deployment runbook

## Boundary and deployment choice

Phase 13 targets a provider-neutral container platform with a private managed PostgreSQL database, a private S3-compatible bucket, managed HTTPS, structured stdout collection, and an external scheduler that invokes the protected publisher endpoint. No provider account or staging credentials were available during preparation, so no remote deployment, DNS, TLS, database, bucket, or production action was performed.

The minimum realistic platform must run a normal OCI container, provide private PostgreSQL with TLS and automated snapshots, provide S3-compatible object storage with versioning/retention, inject secrets at runtime, terminate trusted HTTPS, retain stdout logs, and run an authenticated periodic HTTP job. Vercel's local CLI was present, but the repository had no Vercel project configuration and local durable filesystem storage is unsuitable for a scaled deployment. The container design therefore remains portable to any provider meeting the minimum contract.

## Container and runtime

`Dockerfile` provides a dependency stage, deterministic lockfile install, standalone Next.js build, a separate Prisma migration target, and a non-root production target. The runtime exposes port 3000 and probes `/health/live`. Run schema changes only through the migration image (`prisma migrate deploy`); never use `prisma db push`.

`compose.staging.yml` is a safe local integration profile for PostgreSQL and MinIO. It binds the application only to loopback, keeps database/object storage on an internal network, creates a separate versioned `steyoyoke-cms-staging` bucket, and persists both services in named volumes. Supply secrets from an ignored shell environment or ignored `.env` file. Docker was installed but its daemon was not running during Phase 13, so this profile was config-validated but not started.

## Runtime environment

Required application secrets are `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_BASE_URL`, `LEGACY_API_KEY_A`, and `LEGACY_API_KEY_B`. Use staging-only values. Enable remote media with `MEDIA_STORAGE_PROVIDER=s3`, `MEDIA_S3_BUCKET`, `MEDIA_S3_REGION`, optional provider endpoint, least-privilege access key pair, path-style selection, and a staging prefix. Objects remain private; compatibility delivery always passes through the CMS routes, so canonical records contain keys rather than provider URLs.

The scheduled publisher is off unless `SCHEDULED_PUBLISHER_ENABLED=true`. A scheduler must POST to `/api/internal/publish-scheduled` with `Authorization: Bearer <SCHEDULED_PUBLISHER_SECRET>`. Use a unique secret of at least 32 random characters and a single scheduler registration. `LOG_LEVEL` controls structured JSON stdout.

## Database and catalogue migration

Provision an empty private PostgreSQL database named exactly `steyoyoke_cms_staging`, require TLS where supported, restrict ingress to the app/migration jobs, and enable automated backups before import. The import command refuses any other logical database name and requires `STAGING_CONFIRM_NON_PRODUCTION=steyoyoke_cms_staging`.

Before any catalogue write, `npm run migration:staging` hashes the immutable SQL source and requires:

`180d16528b61f4520cdce86dcc793953dc747804e61d5e61dd019b71a6e48141`

It then applies committed Prisma migrations, verifies the catalogue tables are empty, imports the Phase 12 policy result, regenerates all six image objects from the local FTP snapshot, preserves historical audio as `LEGACY_EXTERNAL`, advances the three legacy sequences, and writes an ignored local quality report. It never resets or drops the staging schema. A partial failed import must be investigated and the dedicated staging database/bucket replaced explicitly; do not rerun over partial data.

Expected counts are 389 Artists, 1,804 Tracks, 380 Podcasts, 600 Releases, 3,423 ReleaseTracks, 4,416 Podcast chapters, 1,157 image assets, 2,177 unique historical audio references, 3,173 initial revisions, and 3,423 ReleaseRevisionTracks. Run `npm run staging:manifest` after compatibility validation to capture the source hash, current commit, latest migration, actual counts, warnings, policy version, HTTP result, media counts, and deployment identifier.

Run `npm run db:seed` only with three new staging-only identities and random passwords supplied at runtime. Never reuse or migrate Tank Auth identities. Public signup remains disabled outside the seed code path.

## Media and audio policy

The S3-compatible provider performs immutable `If-None-Match: *` writes and safe logical-key validation. Source objects are not public. The unchanged image routes provide original, 1440, 1024, 512, 256, and 80 variants with recorded MIME, length, `nosniff`, and immutable caching. The audio route retains safe byte ranges.

Historical audio binaries are not copied in Phase 13. Exact `legacyAudioId` values and raw Track `file_id` values remain in the canonical staging catalogue as external references. Until the owner explicitly authorizes a read-only legacy production audio origin or supplies staging copies, Podcast URLs use the staging `/legacy-audio` base and return 404 for `LEGACY_EXTERNAL` assets. This is strategy C (unavailable historical placeholder semantics), avoids production object access, and must be resolved before real-device audio acceptance. Newly uploaded staging MP3 files use only the staging bucket and are playable.

## Hostname, HTTPS, and DNS handoff

Choose a non-production name such as `cms-staging.steyoyoke.com`. Configure it as the exact CNAME or A/AAAA record supplied by the selected host, verify ownership, and let the provider issue a publicly trusted certificate. Set both auth/base URLs to the final `https://` origin before seeding sessions. Do not use a self-signed certificate for devices. No DNS record was selected or changed in this phase because neither provider nor domain authorization was available.

## HTTP compatibility validation

The local PHP clone requires its dedicated MySQL clone, which was not running during preparation. Once both endpoints exist, compare `LOCAL_LEGACY_HTTP_BASE_URL` with the staging HTTPS origin using staging-only legacy keys. Capture status, contract-sensitive content type, field presence/types, null/empty behavior, ordering, IDs, labels, dates, durations, links, chapters, pagination, media paths, and audio strings.

The mandatory matrix is: complete Artist, Track, Podcast, and Release list output; every Release through `releasecomplete` when runtime permits; first/middle/last pages; all artist/release/title/track-title lookup filters; and multiple real `releasefilter` combinations. Hostname and approved Phase 12 normalizations may be classified; every other difference must be explained. The gate is zero unexplained differences. The earlier serializer comparison remains useful evidence but is not represented as an HTTP pass.

For images, sample each of the six paths and verify 200, detected content type, decoded dimensions, immutable cache header, source identity, and traversal rejection. For audio, verify new staging MP3 full/range delivery and the documented 404 for unresolved historical references without contacting production.

## CMS and scheduler acceptance

Against staging HTTPS, use dedicated acceptance records to test ADMIN, EDITOR, and VIEWER login/RBAC; Artist draft/preview/publish/unpublish; Track edit/publish and optional media; Podcast chapter editing, required artwork/audio, previews, and publication; Release ordering, TrackRevision warning/freezing, and publication; plus image and MP3 upload/preview/reference display.

Create a dedicated Podcast whose chapter text covers accents, straight and curly apostrophes, ampersand, repeated hyphens, en/em dash, Cyrillic, Arabic, emoji, and semicolons. Verify canonical and legacy previews, valid UTF-8 JSON, unchanged timing, and deterministic serialization. Local automated coverage exercises this exact character class; remote CMS acceptance remains required.

Schedule one record of each entity type a few minutes ahead in UTC. Invoke one scheduler registration, then verify exactly one activation, frozen revision selection, audit entry, API visibility, and a no-op second invocation. Existing integration coverage proves per-entity idempotency; the remote job wiring remains required.

## Logging, health, security, and backups

The proxy assigns or propagates a bounded request ID. The container server records completion as JSON with request ID, method, route, final status, and duration; responses carry `X-Request-ID`. Internal failures log only an error class, not request bodies, headers, sessions, passwords, keys, or database URLs. Scheduler output is structured and count-only. `/health/live` performs no dependency work; `/health/ready` executes only `SELECT 1`, returns no configuration, and disables caching.

At the platform edge, force HTTPS and HSTS, limit request size, retain logs, and rate-limit legacy compatibility routes. Better Auth uses secure, HTTP-only, SameSite=Lax cookies in production and trusted-origin CSRF checks; signup is closed. Keep database private, bucket private/versioned, and storage credentials limited to the staging bucket/prefix. Do not expose source maps, environment dumps, provider consoles, database errors, or filesystem paths.

Enable daily PostgreSQL snapshots with at least 14-day retention and object versioning/lifecycle retention before import. Rehearse restore into a new staging-only database and bucket/prefix: restore the snapshot, copy object versions, point a one-off app at the restored resources, run readiness/count/media checks, then delete through provider controls. A local `pg_dump`/`pg_restore` rehearsal is permitted only against the dedicated staging database and must write under ignored `backups/`; no backup belongs in Git. Remote backup/restore evidence is pending provider access.

## Owner warnings and release boundary

Keep Podcast chapter-boundary records 2541, 2763, and 3021; Track 1171's malformed Apple Music URL; and the ten duplicate normalized Artist-name pairs visible in the staging quality report. They do not block staging. The four dangling Release 229 relations remain intentionally omitted, Podcast 1750 remains normalized to 2018-01-09, and Release 263/377 artwork remains recovered.

Phase 13 does not authorize production CMS/database/AWS/S3/DNS/traffic changes. A later phase must select/provision the provider, inject secrets, deploy, import, complete HTTP/media/CMS/device/scheduler acceptance, rehearse managed restore, and approve historical audio behavior before any cutover planning.
