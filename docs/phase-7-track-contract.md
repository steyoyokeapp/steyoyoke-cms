# Phase 7 Track contract

## Canonical and revision rules

`Track` is the editable working copy. Publish and schedule create immutable `TrackRevision` rows. A revision stores both canonical Artist/Label IDs and delivery snapshots (`primaryArtistLegacyId`, names, and `labelLegacyValue`). Consequently, later Artist drafts, Artist republishes, Label renames, or Label deactivation cannot silently change an already-published Track response.

Artwork and audio references are intentionally omitted. Phase 6 has no `MediaAsset` model, so nullable UUIDs would not provide referential integrity. Media will be attached when its domain exists; no legacy media columns or fake URLs are stored canonically.

The `legacy_track_id_seq` sequence begins at the audited post-production high-water value 3337. It is intentionally not Track-specific in meaning: future `PodcastEpisode.legacyId` must default to this same PostgreSQL sequence so Tracks and Podcasts remain in one legacy namespace. IDs allocate when a draft is created and an immutability trigger prevents changes. Sequence values are never reclaimed after rollback or deletion.

Publishing accepts active Labels. An inactive Label can remain attached and can be republished only when it is the Label in the Track's existing published revision. Artist dependencies must have a published revision and be `PUBLISHED`, or be `SCHEDULED` while an existing published revision remains active.

## Compatibility defaults

New canonical Tracks have no legacy release date. List delivery therefore uses `legacyId DESC`, a deterministic creation/allocation ordering that approximates newest-first for new records. Historical import can later preserve separate legacy ordering metadata without inventing a canonical `releaseDate` now.

The normal `type=track` serializer emits the old DB-shaped field set. Canonical links map as follows:

| Canonical | Legacy |
| --- | --- |
| `appleMusicUrl` | `itunes_link` |
| `beatportUrl` | `beatport_link` |
| `bandcampUrl` | `web_link` |
| `traxsourceUrl` | `traxsource_link` |
| `spotifyUrl` | `spotify_link` |
| `soundcloudUrl` | `soundcloud_link` |

The IDs `id`, `artist_id`, and non-null `secondary_artist_id` serialize as JSON strings. `durationMs` serializes as legacy `HH:MM:SS`; null remains null. `label` is the frozen underscore-preserving `Label.legacyValue`. `title` is raw and `artist_name` is the frozen published primary Artist name. A normal Track does not emit `secondary_artist_name`.

Fields absent from the canonical model have explicit compatibility defaults:

| Legacy fields | Default | Reason |
| --- | --- | --- |
| `description`, `artist`, `date`, `artist_feature_times` | `null` | No canonical equivalent in Phase 7 |
| `cover_download`, `cover_thumbnail_low`, `cover_thumbnail_high`, `cover_low`, `cover_high` | `null` | No media pipeline; fake locations are forbidden |
| `podcast_link`, `podcast_link_title` | `null` | Not a Podcast |
| `genre`, `bpm` | `null` | Not canonical Track fields |
| `low_mp3`, `high_mp3`, `file_id` | `null` | No audio asset/import and track-mode file transformation stays suppressed |
| `type` | `"track"` | Compatibility discriminator, not canonical storage |

The envelope retains `base_cover_folder` as `/1440/` and `main_cover_folder` as `/assets/uploads/files`; these are inert compatibility constants while every media field is null. Pagination is applied only when `limit` or `offset` is supplied: `total_rows` is a JSON number while normalized `limit` and `offset` are JSON strings.
