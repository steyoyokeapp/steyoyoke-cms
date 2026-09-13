# Steyoyoke CMS — Phase 1 performance implementation

A. Starting state

Clean HEAD/main/origin/main at `a2e10075297649865da815cf11916659c2a5900f`.
Work isolated on `perf/phase1-data-path`. Production remains the approved build in fra1, with Neon unchanged in Frankfurt.

B. Files changed

- `src/modules/catalogue/{browse,reads,pickers,editor,secondary}.ts`: bounded list, initial editor, search, and secondary read paths.
- Catalogue list/detail/new pages and loading boundaries under `src/app/admin/`.
- `src/components/catalogue-list.tsx`, `catalogue-filters.tsx`, `search-picker.tsx`, `secondary-sections.tsx`, `intent-link.tsx`.
- Existing Artist/Track/Podcast/Release editors and create forms, Artwork/Audio pickers, Media manager and page, stylesheet.
- Auth page resolution/layout and sign-out navigation; pool numeric instrumentation.
- Existing service history reads capped, Media summary selection reduced.
- New authenticated `/api/admin/choices` and `/api/admin/secondary` GET routes.
- Performance benchmark scripts, reports, architecture/session/pool/integration tests, browser workflow adjustments and production navigation configuration.

C. List pagination

All four CMS lists paginate in SQL: 50 visible records plus one look-ahead row for Next. No full-catalogue fetch followed by client slicing. The 51st row is only a pagination sentinel and is never returned to the component. Stable ordering is updatedAt DESC, id DESC. URL query retains page, search, status, Artist and Label filters. Detail links carry a validated same-list return path. Native browser back restores history/scroll where Next supports it; no custom cross-session list cache is added.

D. Summary DTOs

Explicit selects contain visible list fields, lightweight Artist/Label names, current publication version and chapter/track counts. No editor options, artwork graphs, revisions, audits, historical membership or compatibility payloads. Filter controls load small Labels and at most the selected Artist; searching other Artists is on demand.

E. Pickers

One authenticated endpoint provides server-side name/title/Artist/filename/legacy-ID/exact-UUID search with a hard 25-result limit. Input is debounced 250 ms; initial focus may query immediately. Aborted and obsolete responses cannot update results. SearchPicker owns its results locally and preserves the selected object independently of later search results. Current relationships are included even when no longer ordinarily selectable. Ordinary media choices require READY, so the thousands of EXTERNAL audio assets are no longer fetched. An attached EXTERNAL/RETIRED value remains visible, and existing authoritative attachment validation is unchanged. Creation forms use the same architecture. Labels stay eager because the dataset is small.

F. Initial editor architecture

Initial DTOs include editable scalar fields, current attached media summaries, publication/revision/conflict IDs, and current relationships only. Artist includes a scalar revision count for hard-delete button eligibility. Podcast includes ordered working chapters only. Release includes exact working Track IDs/order, summaries for attached Tracks and the small frozen/current revision-ID comparison needed for the existing change warning. Mutation locking and expectedWorkingVersion checks are unchanged. No history loader is called on this path.

G. Secondary data

Preview, revision history and audit trail load only when opened. Histories return 25 rows plus hasMore, with Load more; snapshot requests are scoped to one entity and revision ID. Release snapshot includes its frozen ordered membership; Podcast snapshot includes its frozen chapter sequence. Existing general editor read APIs also cap revisions at 25. Compatibility previews now explicitly show the saved working record alongside published delivery data, rather than continuously serializing every unsaved keystroke. Published releasecomplete remains frozen to the published ReleaseRevision and exact TrackRevisions. Existing legacy delivery routes/serializers are preserved. Media references and technical variants remain selected-item only; its existing full selected-item references API is unchanged.

H. Media diagnosis and fix

Baseline production-sized service calls took 144–194 ms (median 166 ms), 5 SQL statements and 27,197 bytes, while the prior production browser observation was 2.7–3.2 seconds. This establishes that the service measurement alone does not explain the full browser delay; it does not identify an S3 bottleneck.

The old page sent an authenticated shell, waited for client hydration, then issued another authenticated GET for the first page. The new page streams a server-loaded first page under Suspense, with no initial browser list GET. Client fetching remains for subsequent filters/pages/mutations. StrictMode does not cause a redundant first fetch. Technical variant and processing-job reads were removed from list cards; selected detail retains them and destructive buttons still wait for references/detail. Query count is now 3. Across the three after samples, the grouped status-count query took 37–50 ms, the page query including all aggregate reference counts took 63–97 ms, and the creator-name relation query took 37–46 ms. Those driver timings include the workstation/database network path; reference-count CPU cannot be separated from the combined page query using these observations. Thumbnails have fixed dimensions, asynchronous decoding and lazy loading. Cards are not gated on image responses. Audio controls do not preload picker audio.

Stage measurements are in `phase1-media-browser.json`: DOM observer timing measures actual heading/card insertion independently of Playwright assertion polling. The final local production compilation showed heading at 29.5 ms and all 50 cards at 329.9 ms, while the coarse test assertion completed at 813 ms. There were 16 image elements; completed local thumbnail requests observed at capture took 11–17 ms, and card insertion did not wait for every image. The Media route fetch itself took 34.1 ms (TTFB 4 ms); its separately loaded client chunk took 3.8 ms. Browser render/reveal work is contained in the shell-to-card interval, not separately CPU-profiled. The roughly 300 ms shell-to-card interval is consistent with the React/Suspense reveal path; no client list GET occurs. This local test uses local storage and is not an S3 origin benchmark. Existing public media proxy URLs/cache behavior (`public, max-age=31536000, immutable`) are unchanged. S3 origin latency, CDN hit/miss behavior and signed/proxy delivery timings must be observed in the controlled fra1 test; they are not claimed fixed or measured from local results.

I. Session deduplication

Layout and page share React cache() around request headers/session resolution. This cache is scoped to the React render, not global authorization state. Mutation/API routes still call auth.api.getSession authoritatively every request; role checks and revocation behavior are unchanged. Tests cover shared per-render resolution, a fresh user on the next request, invalid roles and uncached mutation auth. Sign-out performs a full document navigation after revoking the session, clearing the client router's private data.

J. Cache strategy

No added cache dependency and no global private response cache. Next handles route/back navigation. Picker and lazy-section data live only in their mounted component; authenticated GET responses are private/no-store. Existing mutation completion reloads the document, invalidating editor/list/secondary state. This favors predictable concurrent-editor safety over stale optimistic record caching.

K. Prefetch

Sidebar loading boundaries use Next's normal partial prefetch. Catalogue rows/pagination disable automatic viewport prefetch and enable it only on hover/focus intent. Leaving/blur removes that intent. Next owns its request scheduler; no loop prefetches all records or all pages. No extra speculative detail-summary cache is introduced.

L–N. Query count, duration and payload results

Three samples per page, median elapsed service duration, bytes of serialized application service data. App queries exclude auth/framework. Both runners use the same dedicated production read-only role, max-three-connection benchmark pool and workstation network path. Calls that previously combined form options include those options in the old totals; new list totals include the small Label filter query. Timings are not fra1 function or production browser timings. Query duration totals can overlap and must not be added to elapsed service duration.

| Page | App queries before → after | Median service ms before → after | Serialized bytes before → after |
|---|---:|---:|---:|
| Artists list | 1 → 1 | 53 → 40 | 222,008 → 9,114 |
| Artist detail | 11 → 4 | 399 → 81 | 283,910 → 392 |
| Tracks list | 7 → 5 | 896 → 121 | 3,727,123 → 16,148 |
| Track detail | 22 → 8 | 1014 → 174 | 1,131,391 → 1,395 |
| Podcasts list | 7 → 5 | 252 → 128 | 1,079,266 → 18,231 |
| Podcast detail | 26 → 9 | 672 → 211 | 1,143,300 → 3,295 |
| Releases list | 12 → 5 | 1246 → 88 | 6,645,281 → 17,904 |
| Release detail | 43 → 14 | 1718 → 266 | 5,727,292 → 1,763 |
| Media | 5 → 3 | 166 → 140 | 27,197 → 23,247 |

Every measured query and payload budget is met. Largest measured initial editor DTO is 3,295 bytes; largest list dataset is 18,231 bytes. Release detail falls from 5.73 MB to 1.76 KB. The Release initial read remains the deepest relation chain (14 statements); primary and secondary Artists both populated or a scheduled revision can add relation work but do not scale with total catalogue size. These bytes measure service DTOs, not the complete Next JS/RSC transport envelope.

Reproduction: copy `scripts/performance/baseline.ts` into an isolated checkout of the starting commit (with generated Prisma client/dependencies and the same local env access), then run it there. It must not be used as an old-baseline runner against the modified services. Run `npx tsx scripts/performance/after.ts` in this branch. Both explicitly require `steyoyoke_inventory_ro` and run reads only; do not substitute the application write URL. Do not commit any env files. Numeric samples are preserved in `phase1-before.jsonl` and `phase1-after.jsonl`.

O. Tests

Full relevant Vitest suite: 184 tests passed across 29 files. Includes database/service publication, revision isolation, release ordering, Podcast chapters, media safety and legacy serializer checks, plus new bounded pagination/picker/initial DTO/session/pool tests. Integration tests exercise 123 equal-timestamp rows without duplicates, search beyond page one, 27 history revisions with pagination, and wrong-record snapshot rejection. Browser tests exercise actual save/publish workflows and lazy preview semantics with no production writes. All 18 Chromium browser tests pass. A separate production-build read-only navigation test passes for all four lists/details and a 50-card Media page, including stale Media bookmark normalization. Local non-Media navigation assertions ranged 41–868 ms; these are coarse automation upper bounds, not DOM-observed content timings or production SLA evidence. The dev server uses an optional CMS_E2E_PORT override (3200 for this run) so another local application can retain port 3000; this changes only the test child process, not application auth configuration.

P. Build/type/lint

Typecheck, production build and git diff --check pass. Lint has zero errors and three existing native-image warnings (local/blob/legacy image paths intentionally avoid a second optimizer). No runtime dependency added; Prettier used as a transient formatter only.

Q. Dedicated review

Reviewed authorization, role checks, private response caching, stale request cancellation, selected values across search, query input validation, safe return URLs, SQL identifier allowlists/parameterized values, mutation invalidation, history/snapshot scoping, retired/external attachment behavior, hard-delete eligibility, release ordering, frozen releasecomplete semantics, chapter editing and expectedWorkingVersion safety. Fixed lazy published releasecomplete semantics, mutation/reload test races, StrictMode's duplicate first Media request and out-of-range Media bookmark normalization. The benchmark and test environments are distinct: production role is read-only; mutating service/browser tests use localhost databases and local storage.

R. Git state

All acceptance checks completed before commit. Work remains isolated on `perf/phase1-data-path`; main/origin/main remain at the approved SHA. No push or deployment is authorized in this phase and neither is performed. No schema/migration, production DB data, catalogue/media, secrets, DATABASE_URL, Neon or Vercel setting changes.

S. Remaining bottlenecks

- Network/auth and Next route/render/stream timing still exist; instant prefetch depends on prior intent and warm resources.
- Release relations still require more dependent rounds than the simpler editors; query volume is bounded by current membership, not total catalogue.
- Aggregate Media reference counts and offset pagination can get more expensive with much larger history/deep pages; they remain candidates for measured follow-up, not speculative schema changes.
- Explicit preview/snapshot operations can be larger than initial DTOs. Selected Media references remain the existing full list, loaded only for selection; a separate reference-pagination design may be useful for very highly reused assets.
- Exact production S3/CDN and cold-start tails are unverified until the controlled deployment test.

T. Expected production performance

The measured data-path and payload reductions support a controlled fra1 test of 200–300 ms warm lists, 300–400 ms editable details and 500–800 ms populated Media. These are targets, not verified production outcomes. No claim is made that all users, cold invocations or networks already meet them. Measure useful content with a DOM observer rather than confusing a loading heading or delayed assertion polling with readiness.

U. Recommendation

DEEP PERFORMANCE PHASE 1 PASSED — READY FOR CONTROLLED PRODUCTION TEST

No push or deployment has been performed. Production timings remain to be validated under explicit deployment authorization.
