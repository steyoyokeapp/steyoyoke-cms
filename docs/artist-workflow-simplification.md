# Artist workflow simplification

Implemented locally from `6fb6f7066dc8e5fffbfbffe6d9b0258d7811cd49` on `feat/artist-workflow-simplification`. Initial working tree was clean. No push or deployment; production application/data/configuration remain unchanged.

## Create and edit

Create artist exposes one Artist name input and Create artist. Artist edit exposes one Artist name input and Save changes. Common navigation/back links remain. Slug, biography, Facebook, artwork, publication actions, previews, revisions, audits and technical metadata are absent from these screens. Viewer fields are read-only; archived records remain protected.

New records retain the canonical slug algorithm (accent normalization, hyphenation, deterministic collision suffixes). Name-only updates preserve the existing slug and legacy ID. The server preserves omitted biography, Facebook and image fields; explicit metadata updates/clears through existing backend APIs still work. Names are trimmed, required and limited to 160 characters. Existing optimistic version checks, transactional locks, permissions and archive rules remain.

Save changes still saves the working draft. It does not automatically publish. Existing publication/scheduling APIs and immutable snapshots remain unchanged; website/mobile legacy delivery continues to use the published revision. Frozen historical biography, Facebook and media remain available to the existing serializer. No schema, migration, serializer, media lifecycle or non-Artist application behavior changed.

Artist detail now selects only id, name, status and workingVersion. Artist list SQL, pagination, search and filters are unchanged. No eager history/audit/picker/media request was introduced.

## Production media dry-run

Used the existing dedicated `steyoyoke_inventory_ro` role and a REPEATABLE READ / READ ONLY transaction. The script checks current Artist associations, Artist revisions, historical Artist attachment audit entries, and every database foreign key targeting MediaAsset (excluding infrastructure child rows from content reference counts). It reports source keys, variants and live reference counts. It performs no detach, retire, delete or storage operation.

- Artists: 389; Artists with media: 177.
- Artist revisions with media: 177; Artist-specific attachment audit entries: 0.
- Candidate assets: 177, all S3_COMPATIBLE.
- Variants: 1,062; distinct recorded source/variant storage keys: 1,239.
- Content references: 354, exactly one current Artist and one Artist revision per asset.
- All 177 assets are Artist-only by entity family, but shared with immutable historical revisions.
- SAFE_TO_DELETE: 0. SHARED_DO_NOT_DELETE: 177. UNCERTAIN_DO_NOT_DELETE: 0.
- Deleted assets, variants, storage objects and detached references: 0.

The existing authoritative Media retirement/deletion service protects current and revision references. None of these assets qualifies for cleanup. Preserving the current relationship also prevents an unrelated media change on a later publication. Revision images remain necessary for frozen legacy compatibility; removing their UI controls does not make the binaries disposable. Storage keys above are recorded database keys, not a fresh S3 existence listing.

Full inventory: `/Users/soulbutton/Documents/steyoyoke-artist-simplification/media-inventory.json`.

## Verification

- Unit/integration suite: 188 tests in 30 files passed, including required/blank/trimmed/duplicate names, metadata retention, frozen snapshots, slug/legacy stability, stale edits, permissions, audit, immutable revisions, media reference safety and bounded catalogue reads.
- Browser suite: 17 of 18 passed on the full run; the remaining Media pagination test initially had an ambiguous status selector matching the existing navigation status spans. Narrowed that test selector to the Media panel; targeted rerun passed. All 18 scenarios are validated across these runs.
- Artist browser coverage verifies the single-field forms, generated slug, repeated persisted saves, no hidden controls and frozen legacy name. Existing Track/Podcast/Release test fixtures now create/publish Artists through the preserved authenticated API because publication is no longer an Artist UI action. Other modules' application code was not changed.
- Typecheck passed. Optimized production builds passed for baseline and candidate using `npm run build -- --webpack`.
- Lint: no errors; three pre-existing image-element warnings in ArtworkPicker/MediaManager.
- Browser screenshot inspected: the editor shows Artist, Artist name and Save changes.
- Local tests were guarded to use localhost databases; production received read-only inventory queries only.

## Local performance comparison

Both builds used identical webpack production compilation, the same local PostgreSQL database, the same published Artist with media, and Chrome. Alternated baseline/candidate order, excluded two warmups, then took 15 full navigation observations per page/build. Measured navigation start to list/editor DOM content ready. These are not the earlier Vercel SPA measurements and do not establish a new production median.

| Page | Baseline median | Candidate median | Baseline p95/max | Candidate p95/max |
|---|---:|---:|---:|---:|
| Artists list | 24.0 ms | 25.6 ms | 36.8 ms | 33.3 ms |
| Artist edit | 32.3 ms | 29.1 ms | 49.3 ms | 74.6 ms |

List median rose 1.6 ms (6.7%) in this small local sample; its SQL, one-query count and 8,590-byte service result were identical. Editor median improved 9.9%; its one higher tail observation is reported rather than hidden. No navigation exceeded one second. This sample does not demonstrate a material regression, but cannot verify the production 135 ms target without an authorized deployment.

For the same Artist, detail service queries fell from 4 to 1 and serialized result from 706 to 136 bytes (80.7% smaller). Observed local service medians were 8 ms baseline and 3 ms candidate. These service summaries include setup/warmups, unlike the browser timing table. Both builds logged zero pool waits and zero warning/error entries; the browser recorded no page errors or 5xx responses.

Raw samples, reproducible benchmark, screenshots, test/build logs and inventory are retained in `/Users/soulbutton/Documents/steyoyoke-artist-simplification/`.

## Exact files changed

- `docs/artist-workflow-simplification.md`
- `scripts/artists/media-inventory.ts`
- `src/app/admin/artists/[id]/page.tsx`
- `src/app/admin/artists/new/page.tsx`
- `src/components/artist-create-form.tsx`
- `src/components/artist-editor.tsx`
- `src/modules/artists/service.ts`
- `src/modules/catalogue/editor.ts`
- `tests/e2e/artist-fixtures.ts`
- `tests/e2e/artist-workflow.spec.ts`
- `tests/e2e/audio-workflow.spec.ts`
- `tests/e2e/media-workflow.spec.ts`
- `tests/e2e/performance.spec.ts`
- `tests/e2e/podcast-workflow.spec.ts`
- `tests/e2e/release-workflow.spec.ts`
- `tests/e2e/track-workflow.spec.ts`
- `tests/integration/artists.test.ts`
- `tests/integration/catalogue-performance.test.ts`

## Delivery

Commit locally after final diff review. Do not push or deploy. The commit SHA and final git status are recorded in the external final report and delivery response, avoiding a self-referential commit hash here.
