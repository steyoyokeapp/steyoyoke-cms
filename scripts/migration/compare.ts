import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { serializeLegacyArtist } from "../../src/modules/artists/legacy";
import { serializeLegacyTrack } from "../../src/modules/tracks/legacy";
import { serializeLegacyPodcast, legacyPodcastLabel, legacyPodcastTitle } from "../../src/modules/podcasts/legacy";
import { serializeLegacyRelease, legacyReleaseLabel, legacyReleaseTitle } from "../../src/modules/releases/legacy";
import { listLegacyReleaseArtists, listLegacyReleaseTitles, listLegacyReleaseTrackTitles, queryPublishedReleaseFilter } from "../../src/modules/releases/legacy-query";
import { formatLegacyDuration } from "../../src/modules/tracks/duration";
import { LocalStorageProvider, type StorageProvider } from "../../src/modules/media/storage";
import type { PrismaClient } from "../../src/generated/prisma/client";
import type { Analysis } from "./types";
import { classifyReleaseTracks, externalAudioInvariantError, migrationRunId } from "./safety";
import { analyzeCatalogue, integer, mapLabel, normalizeLegacyUrl, parseLegacyDate, parseLegacyDuration } from "./analysis";
import { LEGACY_MEDIA_ROOT, LEGACY_SNAPSHOT, REHEARSAL_OUTPUT_ROOT, REHEARSAL_STORAGE_ROOT, rehearsalDatabaseUrl } from "./config";
import { loadLegacySnapshot } from "./legacy-dump";
import { migrationClient } from "./database";
import { checksum } from "../../src/modules/media/image";
import { migrationQualityStatus, type DifferenceClassification } from "./quality";

type Difference = { classification: DifferenceClassification; entity: string; legacyId: number; field: string; source: unknown; canonical: unknown };
const comparable = (value: string | null | undefined) => value?.trim() || null;

function compareField(differences: Difference[], entity: string, legacyId: number, field: string, source: unknown, canonical: unknown, classification: Difference["classification"] = "BUG") {
  if (source !== canonical) differences.push({ classification, entity, legacyId, field, source, canonical });
}

function compareUrls(differences: Difference[], entity: string, legacyId: number, source: Record<string, string | null>, projected: Record<string, unknown>) {
  for (const field of ["itunes_link", "beatport_link", "web_link", "traxsource_link", "spotify_link", "soundcloud_link"]) compareField(differences, entity, legacyId, field, normalizeLegacyUrl(source[field]), projected[field], "EXPECTED NORMALIZATION");
}

export function logicalComparisonFingerprint(result: { sourceSha256: string; compared: Record<string, number>; classifications: Record<string, number>; status: string; differences: Difference[] }) {
  const differences = result.differences.map((difference) => JSON.stringify(difference)).sort();
  return crypto.createHash("sha256").update(JSON.stringify({ sourceSha256: result.sourceSha256, compared: result.compared, classifications: result.classifications, status: result.status, differences })).digest("hex");
}

export async function reconcileMigrationTarget(db: PrismaClient, storage: StorageProvider, analysis: Analysis, runId = migrationRunId(analysis.sourceSha256, "full")) {
    const differences: Difference[] = [];
    const artistIds = analysis.catalogue.artists.map((row) => integer(row.id)).filter((id): id is number => Boolean(id));
    const trackIds = analysis.catalogue.tracks.filter((row) => row.type === "track").map((row) => integer(row.id)).filter((id): id is number => Boolean(id));
    const podcastIds = analysis.catalogue.tracks.filter((row) => row.type === "podcast").map((row) => integer(row.id)).filter((id): id is number => Boolean(id));
    const releaseIds = analysis.catalogue.releases.map((row) => integer(row.id)).filter((id): id is number => Boolean(id));
    const mediaRecords = await db.migrationRecord.findMany({ where: { runId, entityType: { in: ["IMAGE", "AUDIO"] }, canonicalId: { not: null } }, select: { entityType: true, canonicalId: true, sourceIdentity: true } });
    const imageIds = mediaRecords.filter((row) => row.entityType === "IMAGE").map((row) => row.canonicalId!);
    const audioIds = mediaRecords.filter((row) => row.entityType === "AUDIO").map((row) => row.canonicalId!);
    const [artists, tracks, podcasts, releases, imageAssets] = await Promise.all([
      db.artist.findMany({ where: { legacyId: { in: artistIds }, publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { imageAsset: true } } } }),
      db.track.findMany({ where: { legacyId: { in: trackIds }, publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { artworkAsset: true, audioAsset: true } } } }),
      db.podcastEpisode.findMany({ where: { legacyId: { in: podcastIds }, publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { chapters: { orderBy: { position: "asc" } }, artworkAsset: true, audioAsset: true } } } }),
      db.release.findMany({ where: { legacyId: { in: releaseIds }, publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { artworkAsset: true, tracks: { orderBy: { position: "asc" }, include: { trackRevision: { include: { track: true } } } } } } } }),
      db.mediaAsset.findMany({ where: { id: { in: imageIds }, kind: "IMAGE" }, include: { variants: true, processingJob: true } }),
    ]);
    const sourceArtists = new Map(analysis.catalogue.artists.map((row) => [integer(row.id), row]));
    for (const artist of artists) { const source = sourceArtists.get(artist.legacyId)!; const projected = serializeLegacyArtist(artist); compareField(differences, "artist", artist.legacyId, "id", source.id, projected.id); compareField(differences, "artist", artist.legacyId, "name", source.name, projected.name, "EXPECTED NORMALIZATION"); compareField(differences, "artist", artist.legacyId, "facebook_url", normalizeLegacyUrl(source.facebook_url), projected.facebook_url, "EXPECTED NORMALIZATION"); compareField(differences, "artist", artist.legacyId, "description_short", comparable(source.description_short), projected.description_short); if (source.image && projected.image) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "artist", legacyId: artist.legacyId, field: "image", source: source.image, canonical: projected.image }); }
    const sourceTracks = new Map(analysis.catalogue.tracks.map((row) => [integer(row.id), row]));
    for (const track of tracks) { const source = sourceTracks.get(track.legacyId)!; const projected = serializeLegacyTrack(track.publishedRevision!, track.legacyId); compareField(differences, "track", track.legacyId, "id", source.id, projected.id); compareField(differences, "track", track.legacyId, "title", source.title, projected.title, "EXPECTED NORMALIZATION"); compareField(differences, "track", track.legacyId, "artist_id", source.artist_id, projected.artist_id); compareField(differences, "track", track.legacyId, "secondary_artist_id", integer(source.secondary_artist_id)?.toString() ?? null, projected.secondary_artist_id, "EXPECTED NORMALIZATION"); compareField(differences, "track", track.legacyId, "label", mapLabel(source.label), projected.label); compareField(differences, "track", track.legacyId, "duration", formatLegacyDuration(parseLegacyDuration(source.duration) ?? null), projected.duration, "EXPECTED NORMALIZATION"); compareField(differences, "track", track.legacyId, "file_id", source.file_id, projected.file_id); compareUrls(differences, "track", track.legacyId, source, projected); if (source.cover_download && projected.cover_download) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "track", legacyId: track.legacyId, field: "cover_download", source: source.cover_download, canonical: projected.cover_download }); }
    for (const podcast of podcasts) { const source = sourceTracks.get(podcast.legacyId)!; const projected = serializeLegacyPodcast(podcast.publishedRevision!, podcast.legacyId); compareField(differences, "podcast", podcast.legacyId, "id", source.id, projected.id); compareField(differences, "podcast", podcast.legacyId, "title", legacyPodcastTitle(source.title ?? ""), projected.title, "EXPECTED NORMALIZATION"); compareField(differences, "podcast", podcast.legacyId, "artist_id", source.artist_id, projected.artist_id); compareField(differences, "podcast", podcast.legacyId, "label", legacyPodcastLabel(mapLabel(source.label)!), projected.label, "EXPECTED NORMALIZATION"); const sourceDate = parseLegacyDate(source.date); compareField(differences, "podcast", podcast.legacyId, "date", sourceDate instanceof Date ? sourceDate.toISOString().slice(0, 10) : source.date, projected.date, "EXPECTED NORMALIZATION"); compareField(differences, "podcast", podcast.legacyId, "duration", formatLegacyDuration(parseLegacyDuration(source.duration) ?? null), projected.duration, "EXPECTED NORMALIZATION"); const expectedSuffix = `/${encodeURIComponent(source.file_id!)}-high.mp3`; if (!projected.file_id?.endsWith(expectedSuffix)) differences.push({ classification: "BUG", entity: "podcast", legacyId: podcast.legacyId, field: "file_id", source: source.file_id, canonical: projected.file_id }); compareField(differences, "podcast", podcast.legacyId, "chapter_count", analysis.chapters.get(podcast.legacyId)?.rows.length ?? 0, projected.artist_feature_times.length); if (source.cover_download && projected.cover_download) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "podcast", legacyId: podcast.legacyId, field: "cover_download", source: source.cover_download, canonical: projected.cover_download }); }
    const sourceReleases = new Map(analysis.catalogue.releases.map((row) => [integer(row.id), row]));
    const acceptedRelations = classifyReleaseTracks(analysis.catalogue.releaseTracks, new Set(releaseIds), new Set(trackIds)).accepted;
    const relationGroups = Map.groupBy(acceptedRelations, (row) => row.releaseLegacyId);
    for (const release of releases) { const source = sourceReleases.get(release.legacyId)!; const projected = serializeLegacyRelease(release.publishedRevision!, release.legacyId, "complete"); compareField(differences, "release", release.legacyId, "id", source.id, projected.id); compareField(differences, "release", release.legacyId, "title", legacyReleaseTitle(source.title ?? ""), projected.title, "EXPECTED NORMALIZATION"); compareField(differences, "release", release.legacyId, "artist_id", source.artist_id, projected.artist_id); compareField(differences, "release", release.legacyId, "secondary_artist_id", integer(source.secondary_artist_id)?.toString() ?? null, projected.secondary_artist_id, "EXPECTED NORMALIZATION"); compareField(differences, "release", release.legacyId, "label", legacyReleaseLabel(mapLabel(source.label)!), projected.label, "EXPECTED NORMALIZATION"); compareField(differences, "release", release.legacyId, "date", source.date, projected.date); compareUrls(differences, "release", release.legacyId, source, projected); const expectedOrder = (relationGroups.get(release.legacyId) ?? []).map((row) => row.trackLegacyId); const actualOrder = release.publishedRevision!.tracks.map((row) => row.trackRevision.track.legacyId); compareField(differences, "releasecomplete", release.legacyId, "track_order", JSON.stringify(expectedOrder), JSON.stringify(actualOrder), "MIGRATION DATA ISSUE"); if (source.cover_download && projected.cover_download) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "release", legacyId: release.legacyId, field: "cover_download", source: source.cover_download, canonical: projected.cover_download }); }
    const requiredVariants = new Set(["ORIGINAL", "LEGACY_1440", "LEGACY_1024", "LEGACY_512", "LEGACY_THUMB_256", "LEGACY_THUMB_80"]);
    for (const asset of imageAssets) {
      if (asset.provider !== storage.kind) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "provider", source: storage.kind, canonical: asset.provider });
      if (asset.status !== "READY") differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "status", source: "READY", canonical: asset.status });
      if (asset.processingJob?.status !== "COMPLETED") differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "processing_job", source: "COMPLETED", canonical: asset.processingJob?.status ?? null });
      if (!asset.compatibilityFilename?.match(/^[0-9a-f-]{36}\.jpg$/)) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "compatibility_path_shape", source: asset.id, canonical: asset.compatibilityFilename });
      if (!asset.sourceStorageKey || !await storage.exists(asset.sourceStorageKey)) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "source_path", source: asset.id, canonical: asset.sourceStorageKey });
      else if (asset.sha256Checksum !== checksum(await storage.read(asset.sourceStorageKey))) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "source_checksum", source: asset.sha256Checksum, canonical: "storage mismatch" });
      for (const variant of asset.variants) { requiredVariants.delete(variant.variantKey); if (!await storage.exists(variant.storageKey)) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "variant_path", source: asset.id, canonical: variant.storageKey }); else if (variant.sha256Checksum !== checksum(await storage.read(variant.storageKey))) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "variant_checksum", source: variant.sha256Checksum, canonical: "storage mismatch" }); }
      if (requiredVariants.size) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "variant_set", source: asset.id, canonical: [...requiredVariants] });
      requiredVariants.clear(); for (const key of ["ORIGINAL", "LEGACY_1440", "LEGACY_1024", "LEGACY_512", "LEGACY_THUMB_256", "LEGACY_THUMB_80"]) requiredVariants.add(key);
    }
    const [artistLookup, releaseLookup, trackLookup] = await Promise.all([listLegacyReleaseArtists(db), listLegacyReleaseTitles(db), listLegacyReleaseTrackTitles(db)]);
    if (!artistLookup.length || !releaseLookup.length || !trackLookup.length) differences.push({ classification: "BUG", entity: "lookup", legacyId: 0, field: "nonempty", source: "three populated lookup sets", canonical: [artistLookup.length, releaseLookup.length, trackLookup.length] });
    let representativeReleaseFilters = 0;
    const sample = releases[0]?.publishedRevision;
    const sampleTrack = sample?.tracks[0]?.trackRevision;
    if (sample && sampleTrack) {
      const filters = await Promise.all([
        queryPublishedReleaseFilter({ artist: sample.primaryArtistName, paginated: false }, db),
        queryPublishedReleaseFilter({ releaseTitle: sample.title, paginated: false }, db),
        queryPublishedReleaseFilter({ label: sample.labelLegacyValue, paginated: false }, db),
        queryPublishedReleaseFilter({ trackTitle: sampleTrack.title, paginated: false }, db),
      ]);
      representativeReleaseFilters = filters.length;
      filters.forEach((filter, index) => { if (!filter.releases.length) differences.push({ classification: "BUG", entity: "releasefilter", legacyId: 0, field: String(index), source: "at least one representative match", canonical: 0 }); });
    }
    const audioAssets = await db.mediaAsset.findMany({ where: { id: { in: audioIds }, kind: "AUDIO" }, include: { variants: true, processingJob: true } });
    const audioIdentityById = new Map(mediaRecords.filter((row) => row.entityType === "AUDIO").map((row) => [row.canonicalId!, row.sourceIdentity]));
    for (const asset of audioAssets) {
      const expectedLegacyAudioId = audioIdentityById.get(asset.id) ?? "";
      const invariantError = externalAudioInvariantError(asset, expectedLegacyAudioId);
      if (invariantError) differences.push({ classification: "BUG", entity: "audio", legacyId: 0, field: "external_identity", source: "strict LEGACY_EXTERNAL invariant", canonical: invariantError });
    }
    const classifications = Object.fromEntries(["EXPECTED NORMALIZATION", "COMPATIBILITY DIFFERENCE", "MIGRATION DATA ISSUE", "UNCLASSIFIED", "BUG"].map((name) => [name, differences.filter((difference) => difference.classification === name).length]));
    const result = { sourceSha256: analysis.sourceSha256, compared: { artists: artists.length, tracks: tracks.length, podcasts: podcasts.length, releases: releases.length, releaseComplete: releases.length, lookups: 3, representativeReleaseFilters, images: imageAssets.length, historicalAudio: audioAssets.length }, classifications, status: migrationQualityStatus(classifications), differences };
    return { ...result, logicalFingerprint: logicalComparisonFingerprint(result) };
}

export async function compareRehearsal() {
  const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT); const analysis = await analyzeCatalogue(loaded.sourceSha256, loaded.catalogue, LEGACY_MEDIA_ROOT); const db = migrationClient(rehearsalDatabaseUrl());
  try {
    const result = await reconcileMigrationTarget(db, new LocalStorageProvider(REHEARSAL_STORAGE_ROOT), analysis);
    await mkdir(REHEARSAL_OUTPUT_ROOT, { recursive: true, mode: 0o700 }); await writeFile(path.join(REHEARSAL_OUTPUT_ROOT, "comparison.json"), JSON.stringify(result, null, 2), { mode: 0o600 }); return result;
  } finally { await db.$disconnect(); }
}
