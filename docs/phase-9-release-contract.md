# Phase 9 Release contract

## Canonical model

`Release` is the mutable working record. It owns a stable `legacyId`, core metadata, Artist and Label relationships, links, workflow pointers, and an ordered `ReleaseTrack` membership. `ReleaseTrack.position` is zero-based, unique per Release, nonnegative, and normalized to `0..N-1` by the service transaction.

`ReleaseRevision` is an immutable publication snapshot containing Release metadata plus frozen Artist IDs, legacy IDs, delivery names, and Label delivery values. `ReleaseRevisionTrack` is also immutable and points to the exact `TrackRevision` selected at snapshot time. A later Track publication never changes an existing Release revision.

The dedicated `legacy_release_id_seq` begins at 649, immediately above the audited production maximum of 648. Allocation happens at draft creation. IDs are immutable, non-recycling, and rendered as strings by compatibility APIs. The high-water mark exists only in the migration, not application logic.

## Publication contract

Draft persistence requires valid canonical relationships and a nonblank title. Publication additionally requires a date, a published primary Artist, an optional distinct published secondary Artist, a valid Label, at least one Track, contiguous membership, and an active published revision for every included Track. URLs must use HTTPS.

Publishing and scheduling freeze the ordered TrackRevision IDs immediately. Scheduled activation uses that frozen snapshot and rechecks that external Artist and Track dependencies remain active; intervening Release edits or Track republishes do not rewrite the scheduled revision. Unpublishing removes the Release from legacy delivery. Archive/restore preserves the appropriate draft, published, or unpublished state and never auto-publishes an unpublished Release.

Artwork is intentionally absent in Phase 9 because no `MediaAsset` model exists. Cover compatibility fields are `null`, and publication temporarily permits artwork absence. The Media phase must require a READY Release artwork asset before publication.

## Legacy releases

Compatibility is implemented only in the new adapter and reads published immutable revisions:

- `GET /index.php/cms/api?filter=releases`
- `GET /index.php/cms/api/<legacyId>?filter=releases`
- `GET /index.php/cms/api/<legacyId>?filter=releasecomplete`
- `GET /index.php/cms/api?filter=releasefilter`
- lookup filters `allreleaseartist`, `alltitlerelease`, and `alltitletrackrelease`

Published Release ordering is `releaseDate DESC, legacyId DESC`. The legacy implementation specified only the date; `legacyId DESC` is the deterministic tie-break. Paginated envelopes expose numeric `total_rows`, string `limit`/`offset`, and the historical folder metadata.

The exact leading, case-sensitive `Steyoyoke ` prefix is removed only in compatibility output. Label underscores become spaces without changing case. Links map from Bandcamp, Apple Music, Beatport, Traxsource, Spotify, and SoundCloud to `web_link`, `itunes_link`, `beatport_link`, `traxsource_link`, `spotify_link`, and `soundcloud_link`.

Artist aliases intentionally differ by mode:

- paginated releases: `artist_name` and `secondary_artist_name`
- unpaginated releases: `artist_name` only
- single Release: neither alias
- releasecomplete Release: both aliases

`releasecomplete` retains the historical object shape with the Release at key `"0"` and ordered Tracks under `tracks`. A missing Release returns only `tracks: []`. Track data comes from each frozen TrackRevision and uses `artist_track_name` and `secondary_artist_track_name` rather than mutable Artist working rows.

## Legacy releasefilter quirks

The compatibility query layer preserves predicate precedence: `artist`, else `releasetl`, else `label`; `tracktl` applies afterward. Paginated candidates order by Release date, while unpaginated candidates retain the historical Release-ID-descending discrepancy. Track-title filtering excludes zero-match Releases after candidate pagination. Consequently, paginated `total_rows` intentionally counts the base Release predicate before Track-title exclusion and may exceed the returned array length. These behaviors do not leak into canonical Release queries.
