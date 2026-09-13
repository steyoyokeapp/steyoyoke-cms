# Tracks list filter UX cleanup

Base: `0bbbb8a492a07b2efeba4f98c235f26caed87bfc`. Working tree was clean. No Tracks branch existed locally or remotely; created `feat/tracks-simplification` from the current Artist workstream commit. No push or deployment.

## Scope and UX

Tracks only: replaced the stretched grid with a compact wrapping toolbar: Search title, Artist, Label, Status, Filter. Inputs/selects/button are 40 px high, labels align, and Filter no longer stretches into a tall column. At 1280 px the controls share one row; at 390 px title and Artist occupy individual rows, Label/Status share a row and actions follow. A small Clear filters link appears when filters are active and returns to `/admin/tracks` without query parameters.

The Artist control is one editable combobox. It supports server search, mouse and keyboard selection, Escape/blur dismissal, All Artists, loading/error feedback and selected-value retention. Artist IDs remain the actual submitted filter values. An unselected search phrase is not silently submitted as an Artist selection; dismissal restores the selected name.

The existing explicit GET Filter action remains. Submitting filters resets pagination; pagination links preserve active filters. Back/forward restores the URL-derived selection and other fields. Automatic submission was not already supported and would change request timing/behavior, so it was not introduced.

The server renders this component only for Tracks. Existing shared CatalogueFilters and SearchPicker are unchanged. Track create/edit, service/schema/serialization semantics, Artists workflow, Podcasts, Releases and Media are unchanged. CSS is module-scoped.

## Scalable data path

Uses the unchanged authenticated `/api/admin/choices?kind=artist-filter&q=…` endpoint, capped at 25 results. Searches are debounced 250 ms and aborted on query changes or dismissal; stale responses cannot overwrite current results. No initial Artist search request. Initial data contains at most the selected Artist. An open list contains up to 25 server results plus one retained selection and All Artists; closed lists are unmounted. No eager all-Artist list or hidden catalogue DOM.

Server-side Tracks pagination remains 50, with the same DTOs, filters (including primary/secondary Artist matching), stable ordering and query path. No database or API implementation changed.

## Tests

- 20 catalogue unit/integration tests passed.
- Two dedicated browser scenarios passed against the final local production build (also passed in development): Tracks load, title search, bounded Artist search and keyboard selection, Label and Status, combined filtering, 50+5 filtered pagination, canonical Clear filters, back/forward restoration, no eager Artist request/payload, desktop 40 px alignment and mobile toolbar wrapping, stale-response cancellation, retained selection and All Artists.
- Build (`npm run build -- --webpack`) and typecheck passed.
- Lint: zero errors; three existing image-element warnings in unrelated components.
- Desktop/mobile screenshots visually reviewed after streamed content completed.
- Fixture writes were confined to the guarded local development database; architecture tests used the local test database. No production/preview catalogue writes.

## Matched local performance

Identical production webpack builds, local database, Chrome and filters. Alternated baseline/candidate order, excluded two warmups, recorded 15 full navigation-to-table-DOM-ready observations per case/build. Screenshot captures were separate from timed samples.

| Tracks list | Baseline median | Candidate median | Baseline p95/max | Candidate p95/max |
|---|---:|---:|---:|---:|
| Unfiltered | 30.9 ms | 30.0 ms | 56.8 ms | 64.5 ms |
| Combined filters | 32.4 ms | 35.5 ms | 65.6 ms | 64.0 ms |

Filtered median increased 3.1 ms (9.6%) in this small local sample; its tail did not worsen. Unfiltered median improved 0.9 ms. No noticeable local regression was observed, but these localhost full-navigation timings cannot establish production performance against the prior 351 ms SPA median.

All observed Tracks list service spans use four queries in both builds. For matched unfiltered/filtered requests, serialized list results remain exactly 15,663/15,639 bytes in both. Filter-option lookups sit outside that list-service metric and are unchanged. Zero observed pool waits, server errors or browser page/5xx errors during the comparison.

Raw samples and screenshots: `/Users/soulbutton/Documents/steyoyoke-tracks-filter-cleanup/`.

## Exact files changed

- `src/components/catalogue-list.tsx`
- `src/components/tracks-filters.tsx`
- `src/components/tracks-filters.module.css`
- `tests/e2e/tracks-filters.spec.ts`
- `docs/tracks-filter-ux.md`

Commit locally after diff review; record final SHA and git status in the external report. Do not push or deploy.
