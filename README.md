# Steyoyoke CMS Next

Local-first replacement CMS foundation and Artist publishing vertical slice. It is a standalone repository and does not connect to or modify either legacy CMS checkout.

## Stack

- Next.js 16 App Router, React 19, strict TypeScript
- PostgreSQL 16, Prisma ORM 7 with the `pg` driver adapter
- Better Auth with database-backed sessions and scrypt password hashing
- Zod validation at HTTP and service inputs
- Vitest database/unit tests and Playwright browser acceptance tests

## Architecture

The working `Artist` row is the editable canonical draft. Every publish or schedule operation creates an immutable `ArtistRevision`. `publishedRevisionId` is the only source used by the legacy serializer; editing the working row never changes delivered content. A scheduled revision is also frozen at schedule time.

Authorization is enforced inside `src/modules/artists/service.ts`, not only in the UI or route handlers. Admin and Editor can create, edit, publish, schedule, unpublish, archive, and restore. Viewer is read-only. Only Admin can permanently delete, and only a never-published draft with no revisions is eligible.

PostgreSQL owns legacy numeric ID allocation through `legacy_artist_id_seq`. The local sequence starts at 400, but application code contains no production-maximum constant. UUIDs remain canonical identifiers.

## Local setup

Requirements: Node.js 24+ and PostgreSQL 16+.

1. Create one dedicated login and three isolated databases:

   ```sh
   createuser --pwprompt steyoyoke_cms
   createdb --owner=steyoyoke_cms steyoyoke_cms_local
   createdb --owner=steyoyoke_cms steyoyoke_cms_test
   createdb --owner=steyoyoke_cms steyoyoke_cms_shadow
   ```

2. Install dependencies and create ignored local configuration:

   ```sh
   npm install
   cp .env.example .env
   chmod 600 .env
   ```

   Replace every placeholder. Generate secrets locally with `openssl rand -hex 32`. Never commit `.env` or paste seed passwords into logs.

3. Apply migrations, generate the client, and seed role accounts:

   ```sh
   npm run db:deploy
   npm run db:generate
   npm run db:seed
   ```

   Seed account emails and passwords come only from ignored environment values. Re-running the seed is safe and does not print passwords. Public signup remains disabled in the web application.

4. Start the CMS:

   ```sh
   npm run dev
   ```

   Open `http://localhost:3000/sign-in`.

## Environment

`DATABASE_URL` is the application and migration connection. `SHADOW_DATABASE_URL` must point to a distinct disposable schema/database used only by `prisma migrate dev`. `BETTER_AUTH_URL` is the externally visible origin. Production automatically uses secure cookies; deploy behind HTTPS and provide a fresh `BETTER_AUTH_SECRET`.

`LEGACY_API_KEY_A` and `LEGACY_API_KEY_B` are the two compatibility credentials. They are compared server-side and never returned. The local values must be fake and unrelated to legacy or production secrets.

## Provision the owner ADMIN

Provision the first production owner only from a trusted local machine. Pull the linked Vercel project's production environment into an ignored, temporary file, enter the new credentials without terminal echo, and run the dedicated command:

```sh
vercel env pull .env.owner-admin --environment=production
chmod 600 .env.owner-admin
read "OWNER_ADMIN_EMAIL?Owner email: "
read -s "OWNER_ADMIN_PASSWORD?Owner password: " && echo
read "OWNER_ADMIN_NAME?Owner name [Steyoyoke Owner]: "
export OWNER_ADMIN_EMAIL OWNER_ADMIN_PASSWORD
export OWNER_ADMIN_NAME="${OWNER_ADMIN_NAME:-Steyoyoke Owner}"
DOTENV_CONFIG_PATH=.env.owner-admin npm run auth:provision-owner
unset OWNER_ADMIN_EMAIL OWNER_ADMIN_PASSWORD OWNER_ADMIN_NAME
rm .env.owner-admin
```

The command uses Better Auth's configured password hasher and creates the verified `ADMIN` user plus its credential account in one database transaction. It never prints the password or hash. An existing email is refused without changing its name, role, or credential. Public signup remains disabled.

For a routine password change, the signed-in owner can use Better Auth's `changePassword` server endpoint with `revokeOtherSessions: true`. For emergency revocation, delete that user's sessions and credential account and downgrade the role from `ADMIN` through a reviewed database transaction; preserve the user row because authored CMS records may reference it. A future provisioning attempt with the same email will continue to refuse it rather than silently restoring access.

## Artist workflow

- Create allocates a permanent numeric `legacyId`, a UUID, and a deterministic unique slug.
- Save edits only the working row and increments `workingVersion`; stale clients receive HTTP 409.
- Publish freezes the current draft as a new revision and points delivery at it.
- Schedule freezes immediately, stores a UTC instant, and can be cancelled without mutating its revision.
- Unpublish removes the Artist from compatibility delivery immediately while retaining history.
- Archive hides the Artist and cancels any pending schedule. Restore chooses a safe prior visible/unpublished state.
- Permanent delete is intentionally narrow: Admin plus a draft that has never created a revision.

The scheduler is polling/cron compatible and needs no Redis:

```sh
npm run publish:scheduled
```

Run it once per minute in production. Each due row is checked under `FOR UPDATE SKIP LOCKED`; repeated or concurrent runs are idempotent.

## Compatibility API

Phase 6 implements Artists only:

```text
GET /index.php/cms/api?filter=artists
GET /index.php/cms/api/<legacyId>?filter=artists
X-Csrf-Token: <configured compatibility key>
```

Only currently visible published snapshots are returned. Draft, unpublished, and archived records are excluded; a single match is still in an `artists` array. IDs are JSON strings, nullable legacy fields remain `null`, and the `base_cover_folder` and `main_cover_folder` metadata keys are included. Unsupported filters return HTTP 400. Missing or invalid credentials return an HTML-shaped HTTP 401 response.

## Tests and verification

Prepare the isolated test database by applying the same migrations with a `DATABASE_URL` that names `steyoyoke_cms_test`. The Vitest setup automatically switches the configured local database name to the test database before importing application code.

```sh
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:e2e
npm run build
```

Playwright uses an installed Chrome channel. Its acceptance flow verifies create, draft invisibility, publish visibility, post-publication draft isolation, unpublish removal, closed signup, Viewer denial, and session revocation.

## Import handoff

Before importing production Artists, load historical IDs explicitly and then advance the sequence in the same controlled migration/import transaction:

```sql
SELECT setval(
  'legacy_artist_id_seq',
  GREATEST((SELECT COALESCE(MAX("legacyId"), 399) FROM artists), 399),
  true
);
```

The value 399 is only the documented Phase 6 local baseline; the import must calculate from imported data. Existing IDs cannot be changed by normal SQL updates because a database trigger rejects them.

## Deliberate Phase 6 limits

No Tracks, Releases, Podcasts, media processing, public signup, full legacy filter surface, external job queue, production hosting, or legacy data import is included. Artist image remains `null` in compatibility output until the Media vertical is designed. Historical revisions are retained rather than editable or deletable.

At this lockfile revision, `npm audit` reports five upstream toolchain/transitive advisories: Prisma CLI brings an unused MySQL driver and `deepmerge-ts`, while `tsx` brings the flagged esbuild development server version. The PostgreSQL application runtime does not invoke those affected paths. npm's offered high-severity fix is a forced Prisma 7 → 6 downgrade, so it was not applied; recheck for patched stable Prisma/tsx releases before production deployment.
