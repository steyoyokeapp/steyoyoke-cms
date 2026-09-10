import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeLegacyArtist } from "../../src/modules/artists/legacy";
import { serializeLegacyTrack } from "../../src/modules/tracks/legacy";
import { serializeLegacyPodcast, legacyPodcastLabel, legacyPodcastTitle } from "../../src/modules/podcasts/legacy";
import { serializeLegacyRelease, legacyReleaseLabel, legacyReleaseTitle } from "../../src/modules/releases/legacy";
import { listLegacyReleaseArtists, listLegacyReleaseTitles, listLegacyReleaseTrackTitles, queryPublishedReleaseFilter } from "../../src/modules/releases/legacy-query";
import { formatLegacyDuration } from "../../src/modules/tracks/duration";
import { LocalStorageProvider } from "../../src/modules/media/storage";
import { analyzeCatalogue, integer, mapLabel, normalizeLegacyUrl, parseLegacyDuration } from "./analysis";
import { LEGACY_MEDIA_ROOT, LEGACY_SNAPSHOT, REHEARSAL_OUTPUT_ROOT, REHEARSAL_STORAGE_ROOT, rehearsalDatabaseUrl } from "./config";
import { loadLegacySnapshot } from "./legacy-dump";
import { migrationClient } from "./database";

type Difference = { classification: "EXPECTED NORMALIZATION" | "COMPATIBILITY DIFFERENCE" | "MIGRATION DATA ISSUE" | "BUG"; entity: string; legacyId: number; field: string; source: unknown; canonical: unknown };
const comparable = (value: string | null | undefined) => value?.trim() || null;

function compareField(differences: Difference[], entity: string, legacyId: number, field: string, source: unknown, canonical: unknown, classification: Difference["classification"] = "BUG") {
  if (source !== canonical) differences.push({ classification, entity, legacyId, field, source, canonical });
}

function compareUrls(differences: Difference[], entity: string, legacyId: number, source: Record<string, string | null>, projected: Record<string, unknown>) {
  for (const field of ["itunes_link", "beatport_link", "web_link", "traxsource_link", "spotify_link", "soundcloud_link"]) compareField(differences, entity, legacyId, field, normalizeLegacyUrl(source[field]), projected[field], "EXPECTED NORMALIZATION");
}

export async function compareRehearsal() {
  const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT); const analysis = await analyzeCatalogue(loaded.sourceSha256, loaded.catalogue, LEGACY_MEDIA_ROOT); const db = migrationClient(rehearsalDatabaseUrl()); const differences: Difference[] = [];
  try {
    const [artists, tracks, podcasts, releases, imageAssets] = await Promise.all([
      db.artist.findMany({ where: { publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { imageAsset: true } } } }),
      db.track.findMany({ where: { publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { artworkAsset: true, audioAsset: true } } } }),
      db.podcastEpisode.findMany({ where: { publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { chapters: { orderBy: { position: "asc" } }, artworkAsset: true, audioAsset: true } } } }),
      db.release.findMany({ where: { publishedRevisionId: { not: null } }, include: { publishedRevision: { include: { artworkAsset: true, tracks: { orderBy: { position: "asc" }, include: { trackRevision: { include: { track: true } } } } } } } }),
      db.mediaAsset.findMany({ where: { kind: "IMAGE", status: "READY" }, include: { variants: true } }),
    ]);
    const sourceArtists = new Map(analysis.catalogue.artists.map((row) => [integer(row.id), row]));
    for (const artist of artists) { const source = sourceArtists.get(artist.legacyId)!; const projected = serializeLegacyArtist(artist); compareField(differences, "artist", artist.legacyId, "id", source.id, projected.id); compareField(differences, "artist", artist.legacyId, "name", source.name, projected.name, "EXPECTED NORMALIZATION"); compareField(differences, "artist", artist.legacyId, "facebook_url", normalizeLegacyUrl(source.facebook_url), projected.facebook_url, "EXPECTED NORMALIZATION"); compareField(differences, "artist", artist.legacyId, "description_short", comparable(source.description_short), projected.description_short); if (source.image && projected.image) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "artist", legacyId: artist.legacyId, field: "image", source: source.image, canonical: projected.image }); }
    const sourceTracks = new Map(analysis.catalogue.tracks.map((row) => [integer(row.id), row]));
    for (const track of tracks) { const source = sourceTracks.get(track.legacyId)!; const projected = serializeLegacyTrack(track.publishedRevision!, track.legacyId); compareField(differences, "track", track.legacyId, "id", source.id, projected.id); compareField(differences, "track", track.legacyId, "title", source.title, projected.title, "EXPECTED NORMALIZATION"); compareField(differences, "track", track.legacyId, "artist_id", source.artist_id, projected.artist_id); compareField(differences, "track", track.legacyId, "secondary_artist_id", integer(source.secondary_artist_id)?.toString() ?? null, projected.secondary_artist_id, "EXPECTED NORMALIZATION"); compareField(differences, "track", track.legacyId, "label", mapLabel(source.label), projected.label); compareField(differences, "track", track.legacyId, "duration", formatLegacyDuration(parseLegacyDuration(source.duration) ?? null), projected.duration, "EXPECTED NORMALIZATION"); compareField(differences, "track", track.legacyId, "file_id", source.file_id, projected.file_id); compareUrls(differences, "track", track.legacyId, source, projected); if (source.cover_download && projected.cover_download) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "track", legacyId: track.legacyId, field: "cover_download", source: source.cover_download, canonical: projected.cover_download }); }
    for (const podcast of podcasts) { const source = sourceTracks.get(podcast.legacyId)!; const projected = serializeLegacyPodcast(podcast.publishedRevision!, podcast.legacyId); compareField(differences, "podcast", podcast.legacyId, "id", source.id, projected.id); compareField(differences, "podcast", podcast.legacyId, "title", legacyPodcastTitle(source.title ?? ""), projected.title, "EXPECTED NORMALIZATION"); compareField(differences, "podcast", podcast.legacyId, "artist_id", source.artist_id, projected.artist_id); compareField(differences, "podcast", podcast.legacyId, "label", legacyPodcastLabel(mapLabel(source.label)!), projected.label, "EXPECTED NORMALIZATION"); compareField(differences, "podcast", podcast.legacyId, "date", source.date, projected.date); compareField(differences, "podcast", podcast.legacyId, "duration", formatLegacyDuration(parseLegacyDuration(source.duration) ?? null), projected.duration, "EXPECTED NORMALIZATION"); const expectedSuffix = `/${encodeURIComponent(source.file_id!)}-high.mp3`; if (!projected.file_id?.endsWith(expectedSuffix)) differences.push({ classification: "BUG", entity: "podcast", legacyId: podcast.legacyId, field: "file_id", source: source.file_id, canonical: projected.file_id }); compareField(differences, "podcast", podcast.legacyId, "chapter_count", analysis.chapters.get(podcast.legacyId)?.rows.length ?? 0, projected.artist_feature_times.length); if (source.cover_download && projected.cover_download) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "podcast", legacyId: podcast.legacyId, field: "cover_download", source: source.cover_download, canonical: projected.cover_download }); }
    const sourceReleases = new Map(analysis.catalogue.releases.map((row) => [integer(row.id), row])); const relationGroups = Map.groupBy(analysis.catalogue.releaseTracks, (row) => integer(row.release_id));
    for (const release of releases) { const source = sourceReleases.get(release.legacyId)!; const projected = serializeLegacyRelease(release.publishedRevision!, release.legacyId, "complete"); compareField(differences, "release", release.legacyId, "id", source.id, projected.id); compareField(differences, "release", release.legacyId, "title", legacyReleaseTitle(source.title ?? ""), projected.title, "EXPECTED NORMALIZATION"); compareField(differences, "release", release.legacyId, "artist_id", source.artist_id, projected.artist_id); compareField(differences, "release", release.legacyId, "secondary_artist_id", integer(source.secondary_artist_id)?.toString() ?? null, projected.secondary_artist_id, "EXPECTED NORMALIZATION"); compareField(differences, "release", release.legacyId, "label", legacyReleaseLabel(mapLabel(source.label)!), projected.label, "EXPECTED NORMALIZATION"); compareField(differences, "release", release.legacyId, "date", source.date, projected.date); compareUrls(differences, "release", release.legacyId, source, projected); const expectedOrder = (relationGroups.get(release.legacyId) ?? []).filter((row) => integer(row.track_id)).sort((a, b) => Number(a.priority) - Number(b.priority)).map((row) => integer(row.track_id)); const actualOrder = release.publishedRevision!.tracks.map((row) => row.trackRevision.track.legacyId); compareField(differences, "releasecomplete", release.legacyId, "track_order", JSON.stringify(expectedOrder), JSON.stringify(actualOrder), "MIGRATION DATA ISSUE"); if (source.cover_download && projected.cover_download) differences.push({ classification: "EXPECTED NORMALIZATION", entity: "release", legacyId: release.legacyId, field: "cover_download", source: source.cover_download, canonical: projected.cover_download }); }
    const storage = new LocalStorageProvider(REHEARSAL_STORAGE_ROOT); const requiredVariants = new Set(["ORIGINAL", "LEGACY_1440", "LEGACY_1024", "LEGACY_512", "LEGACY_THUMB_256", "LEGACY_THUMB_80"]);
    for (const asset of imageAssets) {
      if (!asset.compatibilityFilename?.match(/^[0-9a-f-]{36}\.jpg$/)) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "compatibility_path_shape", source: asset.id, canonical: asset.compatibilityFilename });
      if (!asset.sourceStorageKey || !await storage.exists(asset.sourceStorageKey)) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "source_path", source: asset.id, canonical: asset.sourceStorageKey });
      for (const variant of asset.variants) { requiredVariants.delete(variant.variantKey); if (!await storage.exists(variant.storageKey)) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "variant_path", source: asset.id, canonical: variant.storageKey }); }
      if (requiredVariants.size) differences.push({ classification: "BUG", entity: "media", legacyId: 0, field: "variant_set", source: asset.id, canonical: [...requiredVariants] });
      requiredVariants.clear(); for (const key of ["ORIGINAL", "LEGACY_1440", "LEGACY_1024", "LEGACY_512", "LEGACY_THUMB_256", "LEGACY_THUMB_80"]) requiredVariants.add(key);
    }
    const [artistLookup, releaseLookup, trackLookup] = await Promise.all([listLegacyReleaseArtists(db), listLegacyReleaseTitles(db), listLegacyReleaseTrackTitles(db)]);
    if (!artistLookup.length || !releaseLookup.length || !trackLookup.length) differences.push({ classification: "BUG", entity: "lookup", legacyId: 0, field: "nonempty", source: "three populated lookup sets", canonical: [artistLookup.length, releaseLookup.length, trackLookup.length] });
    const sample = releases[0]!.publishedRevision!; const sampleTrack = sample.tracks[0]!.trackRevision;
    const filters = await Promise.all([
      queryPublishedReleaseFilter({ artist: sample.primaryArtistName, paginated: false }, db),
      queryPublishedReleaseFilter({ releaseTitle: sample.title, paginated: false }, db),
      queryPublishedReleaseFilter({ label: sample.labelLegacyValue, paginated: false }, db),
      queryPublishedReleaseFilter({ trackTitle: sampleTrack.title, paginated: false }, db),
    ]);
    filters.forEach((filter, index) => { if (!filter.releases.length) differences.push({ classification: "BUG", entity: "releasefilter", legacyId: 0, field: String(index), source: "at least one representative match", canonical: 0 }); });
    const classifications = Object.fromEntries(["EXPECTED NORMALIZATION", "COMPATIBILITY DIFFERENCE", "MIGRATION DATA ISSUE", "BUG"].map((name) => [name, differences.filter((difference) => difference.classification === name).length]));
    const result = { sourceSha256: loaded.sourceSha256, compared: { artists: artists.length, tracks: tracks.length, podcasts: podcasts.length, releases: releases.length, releaseComplete: releases.length, lookups: 3, representativeReleaseFilters: 4 }, classifications, status: classifications.BUG === 0 ? "PASS_WITH_CLASSIFIED_DIFFERENCES" : "FAIL", differences };
    await mkdir(REHEARSAL_OUTPUT_ROOT, { recursive: true, mode: 0o700 }); await writeFile(path.join(REHEARSAL_OUTPUT_ROOT, "comparison.json"), JSON.stringify(result, null, 2), { mode: 0o600 }); return result;
  } finally { await db.$disconnect(); }
}
