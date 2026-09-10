# Phase 10 local image media contract

## Scope and provider boundary

Phase 10 is local-only and image-only. It does not contain an AWS SDK, AWS credentials, S3/CloudFront access, production media, audio upload, transcoding, deployment, or production database access. Application code depends on the small `StorageProvider` interface (`put`, `read`, `exists`, `delete`). The only implementation is `LocalStorageProvider`; a future S3 provider can implement the same boundary without changing content/revision semantics.

`MEDIA_STORAGE_ROOT` configures the physical root and defaults to `.local-storage` inside the repository. That directory is ignored by Git. Storage keys are relative logical keys; absolute filesystem paths are never returned by the CMS or APIs.

## Canonical models

`MediaAsset` owns the immutable source identity, safe UUID compatibility filename, original display filename, detected MIME, byte count, SHA-256, oriented dimensions, creator, lifecycle status, failure detail, reference-retention timestamp, and retirement timestamp. Its statuses are `UPLOADING`, `PROCESSING`, `READY`, `FAILED`, `QUARANTINED`, and `RETIRED`; Phase 10's synchronous happy path moves through processing to ready.

`MediaVariant` owns one immutable derivative. `(mediaAssetId, variantKey)` and every storage key are unique. Database triggers prevent READY metadata identity/checksum changes and variant updates. Variants can only be deleted after the parent is retired as part of an eligible purge.

## Upload security and processing

Sharp decodes actual bytes with corrupt-input failure enabled and a 40-million-pixel decode limit. Browser MIME and filename extensions are not trusted. JPEG, PNG, and WebP are accepted; SVG and all other formats are rejected. The maximum upload is 10 MiB, either dimension is limited to 12,000 pixels, and total pixels to 40 million. EXIF orientation is normalized. Files and directories are created with non-executable owner-only modes, user filenames never become storage keys, and delivery uses `nosniff`.

Source bytes receive a SHA-256 checksum. The normalized `ORIGINAL`, `LEGACY_1440`, `LEGACY_1024`, `LEGACY_512`, `LEGACY_THUMB_256`, and `LEGACY_THUMB_80` variants each receive their own checksum. Aspect ratio is preserved and upscaling is disabled. The numbered legacy variants fit within a square of that size; for example, 400×500 remains 400×500 at 1440/1024/512, becomes approximately 205×256 at 256, and 64×80 at 80. Alpha output stays PNG; non-alpha output is JPEG. The pipeline deliberately does not force WebP/AVIF on old clients.

Storage keys use `images/<asset UUID>/<server variant>.<detected extension>`. The one compatibility filename is `<asset UUID>.jpg` or `.png`; it never changes and is the only filename used in old-app URLs.

## Content, publication, and revisions

Working references are `Artist.imageAssetId`, `Track.artworkAssetId`, `PodcastEpisode.artworkAssetId`, and `Release.artworkAssetId`. Exact IDs are copied to the corresponding immutable revision when Publish or Schedule snapshots a record. Editing working artwork after publication cannot change legacy delivery until a new revision is published, and historical artwork remains referenced.

Artist and Track artwork is optional. Podcast and Release artwork is required for Publish and Schedule. Any selected asset must be `READY`; drafts may remain incomplete. Audio remains explicitly deferred.

## References, retirement, retention, and audit

Reference counting checks all four working tables and all four revision tables. An asset with zero references receives `unreferencedAt`; adding any reference clears it. No file is deleted immediately. `purgeEligibleMedia` selects assets unreferenced for at least 30 days, re-checks all references, retires the asset, removes source and variants, and then removes its canonical record. Tests inject time. Referenced assets cannot be retired.

Meaningful operations create one audit event: `MEDIA_UPLOAD`, `MEDIA_ATTACH`, `MEDIA_REPLACE`, `MEDIA_DETACH`, `MEDIA_RETIRE`, or `MEDIA_PURGE`. Variant creation does not generate audit noise. ADMIN may upload, view, retire, and purge; EDITOR may upload, view, select, and replace; VIEWER may only view. Every API enforces permissions server-side.

## CMS and previews

`/admin/media` lists previews, names, dimensions, size, status, reference count, date, and creator. Detail presentation includes the asset ID, detected MIME, checksum, compatibility filename, logical source key, variants, and reference count without an absolute local path. One reusable artwork picker provides upload, READY selection, preview, replacement, optional removal, and processing/error state across Artists, Tracks, Podcasts, and Releases.

Canonical editor previews expose the working media identity/status/dimensions through the selected asset. Legacy previews and compatibility APIs use the single `LegacyMediaSerializer`, so their path rules cannot drift between modules.

## Legacy compatibility paths

The shared cover mapping is:

| Legacy field | Canonical variant | Virtual URL prefix |
| --- | --- | --- |
| `cover_download` | `ORIGINAL` | `/assets/uploads/files/` |
| `cover_thumbnail_low` | `LEGACY_THUMB_256` | `/assets/uploads/files/thumbnails/256/` |
| `cover_thumbnail_high` | `LEGACY_512` | `/assets/uploads/files/512/` |
| `cover_low` | `LEGACY_1024` | `/assets/uploads/files/1024/` |
| `cover_high` | `LEGACY_1440` | `/assets/uploads/files/1440/` |

The routes are virtual and resolve `(compatibility filename, allowed variant)` through the database and provider. They reject traversal, malformed filenames, arbitrary directories, unknown variants, non-READY assets, and missing storage. Successful immutable assets receive the detected MIME, `nosniff`, and a one-year immutable cache header.

The former physical `thumbnails/512/` defect is intentionally not reproduced. New canonical media uses the valid `/512/` route for `cover_thumbnail_high`. Artist `image`, Track/Podcast/Release covers, and `releasecomplete` all use the artwork frozen in their published revisions. Existing `base_cover_folder`, `main_cover_folder`, null-without-artwork behavior, and Podcast `file_id: null` remain unchanged.

## Known limits and Phase 10.1

Processing is synchronous and local, so it is suitable for proving the software contract rather than horizontally scaled production operation. Phase 10.1 should add audio as a separate media kind and pipeline, preserving shared Track/Podcast legacy sequence behavior and leaving image keys, variants, checksums, revisions, and URLs immutable. AWS/S3 remains a separate infrastructure phase.
