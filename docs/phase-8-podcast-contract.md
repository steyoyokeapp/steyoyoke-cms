# Phase 8 Podcast contract

## Canonical model and publication

`PodcastEpisode` is the editable working record: title, primary/secondary Artist references, Label, true SQL `DATE`, duration in milliseconds, workflow state, and revision pointers. `PodcastChapter` rows are optional structured children with zero-based contiguous positions, Artist, title, optional legacy reference, and optional duration in milliseconds. Saving a submitted chapter list validates it completely, normalizes array order to `0..N-1`, replaces the live rows transactionally, and increments the episode working version once.

Publish and schedule create an immutable `PodcastEpisodeRevision` plus immutable ordered `PodcastChapterRevision` rows. Artist names/legacy IDs and Label name/legacy value are frozen on the episode revision, so later working Artist, Label, Episode, or Chapter changes cannot alter delivered output. Publishing requires a valid published primary Artist, a valid secondary Artist if present, distinct Artists, a usable Label, a non-empty title, an Episode Date, and valid chapters.

Phase 8 intentionally omits artwork/audio fields because no `MediaAsset` model exists. Artwork and audio are temporarily not publication requirements. This exception must be removed when MediaAsset and its processing pipeline are implemented.

## Shared legacy namespace

`PodcastEpisode.legacyId` and `Track.legacyId` both default to `nextval('legacy_track_id_seq')`. No Podcast-specific sequence remains. IDs allocate at draft creation, are not recycled, and cannot be changed. Future catalogue import must preserve cross-table uniqueness when inserting explicit historical IDs.

## Podcast compatibility transformations

The legacy request is `filter=tracks&type=podcast`; output remains Track-shaped.

- Only the exact case-sensitive leading text `Steyoyoke ` is removed from `title`.
- `STEYOYOKE` remains `STEYOYOKE`.
- `STEYOYOKE_BLACK` becomes `STEYOYOKE BLACK`.
- `INNER_SYMPHONY` becomes `INNER SYMPHONY`.
- `episodeDate` becomes timezone-independent `YYYY-MM-DD` using UTC date components.
- Episode and chapter durations become `HH:MM:SS`; null remains null.
- IDs become JSON strings; absent secondary Artist remains null.
- `artist_name` is the frozen primary Artist delivery name.

`artist_feature_times` is a valid JSON array ordered by chapter position. Every new canonical chapter emits keys in this order:

```json
{
  "duration": "00:03:45",
  "title": "Track title",
  "id": "legacy-reference",
  "artist": "Artist name"
}
```

When `legacyReference` is null, `id` is the empty string. This preserves the safe empty-ID behavior of the old parser without reproducing malformed legacy text rows.

## Compatibility defaults

| Legacy fields | Phase 8 value |
| --- | --- |
| `description`, `artist` | `null` |
| `cover_download`, `cover_thumbnail_low`, `cover_thumbnail_high`, `cover_low`, `cover_high` | `null` |
| `podcast_link`, `podcast_link_title`, `genre`, `bpm` | `null` |
| `low_mp3`, `high_mp3`, `file_id` | `null` |
| `itunes_link`, `beatport_link`, `web_link`, `traxsource_link`, `spotify_link`, `soundcloud_link` | `null` |
| `type` | `"podcast"` |

No fake media directories, S3 identifiers, or MP3 locations are generated. The serializer isolates these defaults so future audio/media compatibility can replace them without adding obsolete columns to the canonical model. Envelope folder constants remain `/1440/` and `/assets/uploads/files`, but are inert while media fields are null.

## API pagination and ordering

Unpaginated requests return all visible published Podcasts. Paginated requests return numeric `total_rows`, normalized string `limit` and `offset`, and the `tracks` array. Podcast lists order by `episodeDate DESC`, then `legacyId DESC`. Exact historical ordering during migration still requires verification of imported legacy metadata. `type=track` and `type=podcast` query separate canonical tables even though their IDs share one sequence.
