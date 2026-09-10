# Phase 10.1 local audio media contract

## Scope and architecture

Phase 10.1 extends the existing `MediaAsset` architecture with `kind=AUDIO`. It is local-only: there is no AWS SDK, S3/CloudFront connection, production media, production database access, catalogue import, deployment, or push. Audio uses the existing `StorageProvider` boundary and its sole `LocalStorageProvider` implementation. Canonical storage keys are immutable random paths such as `audio/<media UUID>/source.mp3`; titles and uploaded filenames never determine identity, files are not stored under `public/`, and absolute filesystem paths are not exposed.

## Supported format and validation

MP3 is the only Phase 10.1 format. WAV and additional codecs are deliberately deferred because the current legacy delivery contract expects high-MP3 semantics. The in-process `music-metadata` parser validates actual bytes and requires an MPEG container, Layer 3 codec, audio content, no video, and a finite positive duration. Browser MIME and filename extension are not trusted. Empty, corrupt, disguised, unsupported, over-150-MiB, and over-24-hour inputs are rejected cleanly. No ffprobe, shell, or user-controlled command execution is used.

An AUDIO `MediaAsset` records detected `audio/mpeg`, byte size, source SHA-256, duration in milliseconds, original display filename, unique `sourceStorageKey`, unique `legacyAudioId`, creator, lifecycle status, failure detail, and timestamps. Image-only dimensions and compatibility filenames are nullable for AUDIO; Phase 10 image behavior and six image variants are unchanged. READY metadata and both storage/compatibility identities are protected by database immutability triggers.

## Track and Podcast publication

`Track.audioAssetId` and `TrackRevision.audioAssetId` are nullable. Track audio remains optional, but a selected asset must be `AUDIO` and `READY`. `PodcastEpisode.audioAssetId` is optional while drafting and frozen into `PodcastEpisodeRevision`; both READY image artwork and READY MP3 audio are required for Podcast Publish and Schedule. Scheduled publication revalidates the frozen asset kinds/statuses. Working changes never alter published delivery until republishing, and historical revision references retain old audio.

The shared audio picker supports upload, selection, local HTML audio preview, replacement, optional Track removal, required-Podcast messaging, duration, and status. Canonical previews expose MediaAsset ID, filename, duration, state, and local playback URL. `/admin/media` handles both kinds, filters by kind, avoids misleading image fields for audio, and shows the compatibility ID, duration, checksum, logical storage key, references, creator, and status.

## Legacy `file_id` and local delivery

The canonical database never stores a hard-coded S3 URL. Every new AUDIO asset receives an immutable UUID `legacyAudioId`; a later migration may supply an exact historical raw `file_id` instead. Uniqueness and immutability make either source safe.

- `filter=tracks&type=track` returns the frozen asset's raw `legacyAudioId` as `file_id`, or `null` when Track audio is absent.
- `filter=tracks&type=podcast` applies semantic URL transformation: `<LEGACY_AUDIO_BASE_URL>/<legacyAudioId>-high.mp3`.

`LEGACY_AUDIO_BASE_URL` defaults to `/legacy-audio`. It may later be configured to a real delivery origin without changing canonical records. The virtual local route `/legacy-audio/<id>-high.mp3` resolves only a safe compatibility ID to a READY AUDIO asset and then reads its logical key through `LocalStorageProvider`. It supports full responses and one RFC-style byte range, emits `audio/mpeg`, `Accept-Ranges`, `nosniff`, and immutable caching, and rejects malformed IDs, traversal, invalid/multiple ranges, missing assets, and arbitrary storage paths.

## References, retention, authorization, and audit

Reference discovery covers Track and Podcast working audio plus all Track/Podcast audio revisions, alongside the existing image references. Adding a reference clears `unreferencedAt`; reaching zero starts the same 30-day clock. Purge rechecks all references before deleting the source. Historical revisions therefore protect their exact audio.

Existing permissions remain: ADMIN can upload/view/retire/purge, EDITOR can upload/view/select/replace, and VIEWER can only view. Server-side attachment validation enforces kind and READY status. Meaningful `MEDIA_UPLOAD`, `MEDIA_ATTACH`, `MEDIA_REPLACE`, `MEDIA_DETACH`, `MEDIA_RETIRE`, and `MEDIA_PURGE` events are reused; audio upload metadata includes `kind=AUDIO`, duration, and compatibility ID.

## Future migration and infrastructure boundaries

No historical `file_id` values or legacy audio objects are migrated in this phase. A migration rehearsal can create AUDIO assets with the exact historical ID in `legacyAudioId`, preserve immutable canonical keys, and choose `LEGACY_AUDIO_BASE_URL` for the rehearsal environment. S3 remains a separate provider/infrastructure phase: an eventual `S3StorageProvider` can replace local storage without changing IDs, content revisions, serializers, or reference semantics.
