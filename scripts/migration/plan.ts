import path from "node:path";
import { readFile } from "node:fs/promises";
import { analyzeCatalogue, integer, mapLabel, normalizeLegacyUrl, parseLegacyDate, parseLegacyDuration, resolveArtworkSourceDetailed } from "./analysis";
import { LEGACY_MEDIA_ROOT, LEGACY_SNAPSHOT } from "./config";
import { stableUuid, migrationSlug } from "./identity";
import { loadLegacySnapshot } from "./legacy-dump";
import { historicalImageId, historicalImageSourceIdentity } from "./media";
import { migrationClient } from "./database";
import { selectMigrationScope, type MigrationScope } from "./scope";
import { inspectImage } from "../../src/modules/media/image";
import { CANONICAL_LABELS, classifyReleaseTracks, externalAudioInvariantError, matchesExpectedRecord, MIGRATION_ACTOR, migrationRunId } from "./safety";

const VARIANTS = ["ORIGINAL", "LEGACY_1440", "LEGACY_1024", "LEGACY_512", "LEGACY_THUMB_256", "LEGACY_THUMB_80"];
const clean = (value: string | null | undefined) => value?.trim() || null;
const labelId = (legacyValue: string) => CANONICAL_LABELS.find((label) => label.legacyValue === legacyValue)!.id;
const links = (row: Record<string, string | null | undefined>) => ({ spotifyUrl: normalizeLegacyUrl(row.spotify_link), beatportUrl: normalizeLegacyUrl(row.beatport_link), traxsourceUrl: normalizeLegacyUrl(row.traxsource_link), bandcampUrl: normalizeLegacyUrl(row.web_link), appleMusicUrl: normalizeLegacyUrl(row.itunes_link), soundcloudUrl: normalizeLegacyUrl(row.soundcloud_link) });

type PlanState = "CREATE" | "EXISTING_MATCH" | "CONFLICT";
type PlanItem = { key: string; kind: string; id: string; state: PlanState; reason?: string };

function statusOf(actual: Record<string, unknown> | null, expected: Record<string, unknown>, extraError?: string | null) {
  if (!actual) return { state: "CREATE" as const };
  if (extraError || !matchesExpectedRecord(actual, expected)) return { state: "CONFLICT" as const, reason: extraError ?? "canonical fields differ" };
  return { state: "EXISTING_MATCH" as const };
}

export async function buildMigrationPlan(scope: MigrationScope = "full", databaseUrl?: string) {
  const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT);
  const selected = selectMigrationScope(loaded.catalogue, scope);
  const analysis = await analyzeCatalogue(loaded.sourceSha256, selected.catalogue, LEGACY_MEDIA_ROOT);
  const runId = migrationRunId(loaded.sourceSha256, selected.scopeKey);
  const expectedImageProvider = process.env.MEDIA_STORAGE_PROVIDER?.trim().toLowerCase() === "s3" ? "S3_COMPATIBLE" : "LOCAL";
  const images = new Map<string, { id: string; sourceIdentity: string; sourcePath: string; sourceStorageKey: string; checksum: string; variantStorageKeys: string[] }>();
  const artworkIds = new Map<string, string>();
  const groups: Array<[string, typeof selected.catalogue.artists, string[]]> = [
    ["artists", selected.catalogue.artists, ["image"]],
    ["tracks", selected.catalogue.tracks, ["cover_download", "cover_high", "cover_low", "cover_thumbnail_high", "cover_thumbnail_low"]],
    ["releases", selected.catalogue.releases, ["cover_download", "cover_high", "cover_low", "cover_thumbnail_high", "cover_thumbnail_low"]],
  ];
  for (const [table, rows, fields] of groups) for (const row of rows) {
    const resolved = await resolveArtworkSourceDetailed(LEGACY_MEDIA_ROOT, row, fields); if (!resolved) continue;
    const inspected = await inspectImage(await readFile(resolved.path));
    const identity = historicalImageSourceIdentity(LEGACY_MEDIA_ROOT, resolved.path, inspected.sourceChecksum); const id = historicalImageId(identity);
    const extension = inspected.hasAlpha ? "png" : "jpg"; const sourceExtension = inspected.sourceFormat === "jpeg" ? "jpg" : inspected.sourceFormat;
    images.set(identity, { id, sourceIdentity: identity, sourcePath: path.relative(LEGACY_MEDIA_ROOT, resolved.path).split(path.sep).join("/"), checksum: inspected.sourceChecksum, sourceStorageKey: `images/${id}/source.${sourceExtension}`, variantStorageKeys: VARIANTS.map((key) => `images/${id}/${key.toLowerCase().replaceAll("_", "-")}.${extension}`) });
    const legacyId = integer(row.id); if (legacyId) artworkIds.set(`${table}:${legacyId}`, id);
  }
  const audioIds = [...new Set(selected.catalogue.tracks.map((row) => row.file_id?.trim()).filter((value): value is string => Boolean(value)))].sort();
  const relationPolicy = classifyReleaseTracks(selected.catalogue.releaseTracks, new Set(selected.closure.releases), new Set(selected.closure.tracks));
  const artistRows = new Map(selected.catalogue.artists.map((row) => [integer(row.id), row]));
  const artistSnapshot = (legacyId: number | null) => legacyId ? { id: stableUuid("artist", legacyId), legacyId, name: clean(artistRows.get(legacyId)?.name) } : null;
  const expected = {
    actor: MIGRATION_ACTOR,
    labels: CANONICAL_LABELS,
    artists: selected.catalogue.artists.flatMap((row) => {
      const legacyId = integer(row.id); const name = clean(row.name); if (!legacyId || !name) return [];
      const id = stableUuid("artist", legacyId); const revisionId = stableUuid("artist-revision", legacyId);
      const fields = { name, slug: migrationSlug(name, legacyId), shortBio: clean(row.description_short), facebookUrl: normalizeLegacyUrl(row.facebook_url), imageAssetId: artworkIds.get(`artists:${legacyId}`) ?? null };
      return [{ legacyId, id, revisionId, data: { legacyId, ...fields, workingVersion: 1 }, revisionData: { id: revisionId, artistId: id, revisionNumber: 1, sourceWorkingVersion: 1, ...fields, createdById: MIGRATION_ACTOR.id } }];
    }),
    tracks: selected.catalogue.tracks.filter((row) => row.type === "track").flatMap((row) => {
      const legacyId = integer(row.id); const primary = integer(row.artist_id); const mapped = mapLabel(row.label); if (!legacyId || !primary || !mapped) return [];
      const secondaryLegacy = integer(row.secondary_artist_id); const secondary = secondaryLegacy && secondaryLegacy !== primary ? artistSnapshot(secondaryLegacy) : null; const primaryArtist = artistSnapshot(primary)!;
      const id = stableUuid("track", legacyId); const revisionId = stableUuid("track-revision", legacyId);
      const fields = { title: clean(row.title), primaryArtistId: primaryArtist.id, secondaryArtistId: secondary?.id ?? null, labelId: labelId(mapped), durationMs: parseLegacyDuration(row.duration) ?? null, artworkAssetId: artworkIds.get(`tracks:${legacyId}`) ?? null, audioAssetId: clean(row.file_id) ? stableUuid("legacy-audio", clean(row.file_id)!) : null, ...links(row) };
      return [{ legacyId, id, revisionId, data: { legacyId, ...fields, workingVersion: 1 }, revisionData: { id: revisionId, trackId: id, revisionNumber: 1, sourceWorkingVersion: 1, ...fields, primaryArtistLegacyId: primaryArtist.legacyId, primaryArtistName: primaryArtist.name, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelName: CANONICAL_LABELS.find((label) => label.legacyValue === mapped)!.name, labelLegacyValue: mapped, createdById: MIGRATION_ACTOR.id } }];
    }),
    podcasts: selected.catalogue.tracks.filter((row) => row.type === "podcast").flatMap((row) => {
      const legacyId = integer(row.id); const primary = integer(row.artist_id); const mapped = mapLabel(row.label); if (!legacyId || !primary || !mapped) return [];
      const secondaryLegacy = integer(row.secondary_artist_id); const secondary = secondaryLegacy && secondaryLegacy !== primary ? artistSnapshot(secondaryLegacy) : null; const primaryArtist = artistSnapshot(primary)!;
      const id = stableUuid("podcast", legacyId); const revisionId = stableUuid("podcast-revision", legacyId);
      const fields = { title: clean(row.title), primaryArtistId: primaryArtist.id, secondaryArtistId: secondary?.id ?? null, labelId: labelId(mapped), episodeDate: parseLegacyDate(row.date), durationMs: parseLegacyDuration(row.duration) ?? null, artworkAssetId: artworkIds.get(`tracks:${legacyId}`) ?? null, audioAssetId: clean(row.file_id) ? stableUuid("legacy-audio", clean(row.file_id)!) : null };
      return [{ legacyId, id, revisionId, chapterCount: analysis.chapters.get(legacyId)?.rows.length ?? 0, data: { legacyId, ...fields, workingVersion: 1 }, revisionData: { id: revisionId, episodeId: id, revisionNumber: 1, sourceWorkingVersion: 1, ...fields, primaryArtistLegacyId: primaryArtist.legacyId, primaryArtistName: primaryArtist.name, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelName: CANONICAL_LABELS.find((label) => label.legacyValue === mapped)!.name, labelLegacyValue: mapped, createdById: MIGRATION_ACTOR.id } }];
    }),
    releases: selected.catalogue.releases.flatMap((row) => {
      const legacyId = integer(row.id); const primary = integer(row.artist_id); const mapped = mapLabel(row.label); if (!legacyId || !primary || !mapped) return [];
      const secondaryLegacy = integer(row.secondary_artist_id); const secondary = secondaryLegacy && secondaryLegacy !== primary ? artistSnapshot(secondaryLegacy) : null; const primaryArtist = artistSnapshot(primary)!;
      const id = stableUuid("release", legacyId); const revisionId = stableUuid("release-revision", legacyId);
      const fields = { title: clean(row.title), primaryArtistId: primaryArtist.id, secondaryArtistId: secondary?.id ?? null, releaseDate: parseLegacyDate(row.date), labelId: labelId(mapped), artworkAssetId: artworkIds.get(`releases:${legacyId}`) ?? null, ...links(row) };
      return [{ legacyId, id, revisionId, data: { legacyId, ...fields, workingVersion: 1 }, revisionData: { id: revisionId, releaseId: id, revisionNumber: 1, sourceWorkingVersion: 1, ...fields, primaryArtistLegacyId: primaryArtist.legacyId, primaryArtistName: primaryArtist.name, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelName: CANONICAL_LABELS.find((label) => label.legacyValue === mapped)!.name, labelLegacyValue: mapped, createdById: MIGRATION_ACTOR.id } }];
    }),
    releaseTracks: relationPolicy.accepted.map((row) => ({ releaseLegacyId: row.releaseLegacyId, trackLegacyId: row.trackLegacyId, position: row.position, id: stableUuid("release-track", `${row.releaseLegacyId}:${row.trackLegacyId}`), revisionTrackId: stableUuid("release-revision-track", `${row.releaseLegacyId}:${row.trackLegacyId}`) })),
    rejectedReleaseTracks: relationPolicy.rejected.map(({ row, reason }) => ({ releaseId: row.release_id, trackId: row.track_id, priority: row.priority, reason })),
    images: [...images.values()].sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity)),
    audio: audioIds.map((legacyAudioId) => ({ legacyAudioId, id: stableUuid("legacy-audio", legacyAudioId), copiedBinary: false })),
  };

  const items: PlanItem[] = [];
  const inspect = async (key: string, kind: string, id: string, lookup: () => Promise<Record<string, unknown> | null>, expectedData: Record<string, unknown>, extra?: (actual: Record<string, unknown>) => string | null) => {
    const actual = await lookup(); const result = statusOf(actual, expectedData, actual && extra ? extra(actual) : null); items.push({ key, kind, id, ...result });
  };
  if (databaseUrl) {
    const db = migrationClient(databaseUrl);
    try {
      await inspect("actor", "Actor", expected.actor.id, () => db.user.findFirst({ where: { OR: [{ id: expected.actor.id }, { email: expected.actor.email }] } }), expected.actor);
      for (const label of expected.labels) await inspect(`label:${label.legacyValue}`, "Label", label.id, () => db.label.findFirst({ where: { OR: [{ id: label.id }, { legacyValue: label.legacyValue }, { slug: label.slug }] } }), label);
      const inspectCatalogue = async (kind: string, table: "artist" | "track" | "podcastEpisode" | "release", item: { legacyId: number; id: string; revisionId: string; data: Record<string, unknown>; revisionData: Record<string, unknown> }) => {
        await inspect(`${kind}:${item.legacyId}`, kind, item.id, () => (db[table] as unknown as { findFirst(args: unknown): Promise<Record<string, unknown> | null> }).findFirst({ where: { OR: [{ id: item.id }, { legacyId: item.legacyId }] } }), { id: item.id, ...item.data }, (actual) => actual.publishedRevisionId && actual.publishedRevisionId !== item.revisionId ? "published revision has unrelated identity" : null);
        const revisionTable = kind === "Artist" ? db.artistRevision : kind === "Track" ? db.trackRevision : kind === "Podcast" ? db.podcastEpisodeRevision : db.releaseRevision;
        const parentKey = kind === "Artist" ? "artistId" : kind === "Track" ? "trackId" : kind === "Podcast" ? "episodeId" : "releaseId";
        await inspect(`${kind}Revision:${item.legacyId}`, `${kind}Revision`, item.revisionId, () => (revisionTable as unknown as { findFirst(args: unknown): Promise<Record<string, unknown> | null> }).findFirst({ where: { OR: [{ id: item.revisionId }, { [parentKey]: item.id, revisionNumber: 1 }] } }), item.revisionData);
      };
      for (const item of expected.artists) await inspectCatalogue("Artist", "artist", item);
      for (const item of expected.tracks) await inspectCatalogue("Track", "track", item);
      for (const item of expected.podcasts) await inspectCatalogue("Podcast", "podcastEpisode", item);
      for (const item of expected.releases) await inspectCatalogue("Release", "release", item);
      for (const item of expected.releaseTracks) {
        const relationData = { id: item.id, releaseId: stableUuid("release", item.releaseLegacyId), trackId: stableUuid("track", item.trackLegacyId), position: item.position };
        await inspect(`ReleaseTrack:${item.releaseLegacyId}:${item.trackLegacyId}`, "ReleaseTrack", item.id, () => db.releaseTrack.findFirst({ where: { OR: [{ id: item.id }, { releaseId: relationData.releaseId, trackId: relationData.trackId }, { releaseId: relationData.releaseId, position: item.position }] } }), relationData);
        const revisionRelationData = { id: item.revisionTrackId, releaseRevisionId: stableUuid("release-revision", item.releaseLegacyId), trackRevisionId: stableUuid("track-revision", item.trackLegacyId), position: item.position };
        await inspect(`ReleaseRevisionTrack:${item.releaseLegacyId}:${item.trackLegacyId}`, "ReleaseRevisionTrack", item.revisionTrackId, () => db.releaseRevisionTrack.findFirst({ where: { OR: [{ id: item.revisionTrackId }, { releaseRevisionId: revisionRelationData.releaseRevisionId, trackRevisionId: revisionRelationData.trackRevisionId }, { releaseRevisionId: revisionRelationData.releaseRevisionId, position: item.position }] } }), revisionRelationData);
      }
      for (const item of expected.images) await inspect(`Image:${item.sourceIdentity}`, "Image", item.id, () => db.mediaAsset.findFirst({ where: { OR: [{ id: item.id }, { sourceStorageKey: item.sourceStorageKey }] }, include: { variants: true, processingJob: true } }), { id: item.id, kind: "IMAGE", provider: expectedImageProvider, sourceStorageKey: item.sourceStorageKey, sha256Checksum: item.checksum }, (actual) => {
        const job = actual.processingJob as { status?: string } | null; const variants = actual.variants as Array<{ variantKey?: string }> | undefined;
        const keys = new Set(variants?.map((variant) => variant.variantKey) ?? []);
        return actual.status !== "READY" || job?.status !== "COMPLETED" || variants?.length !== 6 || VARIANTS.some((key) => !keys.has(key)) ? "image is not READY with one completed job and the exact six variants" : null;
      });
      for (const item of expected.audio) await inspect(`Audio:${item.legacyAudioId}`, "Audio", item.id, () => db.mediaAsset.findFirst({ where: { OR: [{ id: item.id }, { legacyAudioId: item.legacyAudioId }] }, include: { variants: true, processingJob: true } }), { id: item.id }, (actual) => externalAudioInvariantError(actual, item.legacyAudioId));
    } finally { await db.$disconnect(); }
  } else {
    items.push(
      { key: "actor", kind: "Actor", id: expected.actor.id, state: "CREATE" },
      ...expected.labels.map((item) => ({ key: `label:${item.legacyValue}`, kind: "Label", id: item.id, state: "CREATE" as const })),
      ...expected.artists.flatMap((item) => [{ key: `Artist:${item.legacyId}`, kind: "Artist", id: item.id, state: "CREATE" as const }, { key: `ArtistRevision:${item.legacyId}`, kind: "ArtistRevision", id: item.revisionId, state: "CREATE" as const }]),
      ...expected.tracks.flatMap((item) => [{ key: `Track:${item.legacyId}`, kind: "Track", id: item.id, state: "CREATE" as const }, { key: `TrackRevision:${item.legacyId}`, kind: "TrackRevision", id: item.revisionId, state: "CREATE" as const }]),
      ...expected.podcasts.flatMap((item) => [{ key: `Podcast:${item.legacyId}`, kind: "Podcast", id: item.id, state: "CREATE" as const }, { key: `PodcastRevision:${item.legacyId}`, kind: "PodcastRevision", id: item.revisionId, state: "CREATE" as const }]),
      ...expected.releases.flatMap((item) => [{ key: `Release:${item.legacyId}`, kind: "Release", id: item.id, state: "CREATE" as const }, { key: `ReleaseRevision:${item.legacyId}`, kind: "ReleaseRevision", id: item.revisionId, state: "CREATE" as const }]),
      ...expected.releaseTracks.map((item) => ({ key: `ReleaseTrack:${item.releaseLegacyId}:${item.trackLegacyId}`, kind: "ReleaseTrack", id: item.id, state: "CREATE" as const })),
      ...expected.releaseTracks.map((item) => ({ key: `ReleaseRevisionTrack:${item.releaseLegacyId}:${item.trackLegacyId}`, kind: "ReleaseRevisionTrack", id: item.revisionTrackId, state: "CREATE" as const })),
      ...expected.images.map((item) => ({ key: `Image:${item.sourceIdentity}`, kind: "Image", id: item.id, state: "CREATE" as const })),
      ...expected.audio.map((item) => ({ key: `Audio:${item.legacyAudioId}`, kind: "Audio", id: item.id, state: "CREATE" as const })),
    );
  }
  const inventory = { created: items.filter((item) => item.state === "CREATE").length, existing: items.filter((item) => item.state === "EXISTING_MATCH").length, conflicting: items.filter((item) => item.state === "CONFLICT").length, items, conflicts: items.filter((item) => item.state === "CONFLICT").map((item) => `${item.kind} ${item.id}: ${item.reason}`) };
  const createdIds = new Set(items.filter((item) => item.state === "CREATE").map((item) => item.id));
  const warningCounts = Object.fromEntries(["BLOCKER", "WARNING", "COMPATIBILITY", "INFORMATIONAL"].map((severity) => [severity, analysis.issues.filter((issue) => issue.severity === severity).length]));
  return {
    mode: "PLAN_NO_WRITE", sourceSha256: loaded.sourceSha256, runId, scopeKey: selected.scopeKey, closure: selected.closure,
    counts: { ...analysis.counts, acceptedReleaseTracks: expected.releaseTracks.length, rejectedReleaseTracks: expected.rejectedReleaseTracks.length }, warnings: warningCounts, issues: analysis.issues, expected, inventory, imageJobCount: images.size,
    sequenceMinimumNext: { artist: Math.max(400, Math.max(0, ...selected.closure.artists) + 1), trackPodcast: Math.max(3337, Math.max(0, ...selected.closure.tracks, ...selected.closure.podcasts) + 1), release: Math.max(649, Math.max(0, ...selected.closure.releases) + 1) },
    projectedRollbackOwnership: {
      workingRows: [...expected.artists, ...expected.tracks, ...expected.podcasts, ...expected.releases].filter(({ id }) => createdIds.has(id)).map(({ id }) => id),
      revisions: [...expected.artists, ...expected.tracks, ...expected.podcasts, ...expected.releases].filter(({ revisionId }) => createdIds.has(revisionId)).map(({ revisionId }) => revisionId),
      releaseTracks: expected.releaseTracks.filter(({ id }) => createdIds.has(id)).map(({ id }) => id),
      releaseRevisionTracks: expected.releaseTracks.filter(({ revisionTrackId }) => createdIds.has(revisionTrackId)).map(({ revisionTrackId }) => revisionTrackId),
      mediaAssets: [...expected.images, ...expected.audio].filter(({ id }) => createdIds.has(id)).map(({ id }) => id),
      mediaProcessingJobs: expected.images.filter(({ id }) => createdIds.has(id)).map(({ sourceIdentity }) => stableUuid("migration-image-job", sourceIdentity)),
      storageKeys: expected.images.filter(({ id }) => createdIds.has(id)).flatMap(({ sourceStorageKey, variantStorageKeys }) => [sourceStorageKey, ...variantStorageKeys]),
    },
  };
}
