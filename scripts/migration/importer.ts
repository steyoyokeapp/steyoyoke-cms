import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { analyzeCatalogue, classifyRejectedChapterLine, integer, mapLabel, normalizeLegacyUrl, parseLegacyDate, parseLegacyDuration, resolveArtworkSource } from "./analysis";
import { applyMigrations, migrationClient, resetRehearsalDatabase } from "./database";
import { stableUuid, migrationSlug } from "./identity";
import { loadLegacySnapshot } from "./legacy-dump";
import { RehearsalMediaImporter } from "./media";
import { LEGACY_MEDIA_ROOT, LEGACY_SNAPSHOT, REHEARSAL_OUTPUT_ROOT, REHEARSAL_REPORT_PATH, REHEARSAL_STORAGE_ROOT, rehearsalDatabaseUrl } from "./config";
import type { Analysis, MigrationIssueInput, RawRow } from "./types";
import { NORMALIZATION_RULES_VERSION } from "./policy";

const ACTOR_ID = "00000000-0000-4000-8000-000000000011";
const LABELS = [
  { id: "00000000-0000-4000-8000-000000000101", name: "Steyoyoke", slug: "steyoyoke", legacyValue: "STEYOYOKE" },
  { id: "00000000-0000-4000-8000-000000000102", name: "Steyoyoke Black", slug: "steyoyoke-black", legacyValue: "STEYOYOKE_BLACK" },
  { id: "00000000-0000-4000-8000-000000000103", name: "Inner Symphony", slug: "inner-symphony", legacyValue: "INNER_SYMPHONY" },
] as const;

const clean = (value: string | null | undefined) => value?.trim() || null;
const artistUuid = (legacyId: number) => stableUuid("artist", legacyId);
const trackUuid = (legacyId: number) => stableUuid("track", legacyId);
const podcastUuid = (legacyId: number) => stableUuid("podcast", legacyId);
const releaseUuid = (legacyId: number) => stableUuid("release", legacyId);
const labelId = (legacyValue: string) => LABELS.find((label) => label.legacyValue === legacyValue)!.id;

function links(row: RawRow) {
  return { spotifyUrl: normalizeLegacyUrl(row.spotify_link), beatportUrl: normalizeLegacyUrl(row.beatport_link), traxsourceUrl: normalizeLegacyUrl(row.traxsource_link), bandcampUrl: normalizeLegacyUrl(row.web_link), appleMusicUrl: normalizeLegacyUrl(row.itunes_link), soundcloudUrl: normalizeLegacyUrl(row.soundcloud_link) };
}

function hasBlocker(analysis: Analysis, table: string, legacyId: number) {
  return analysis.issues.some((candidate) => candidate.sourceTable === table && candidate.sourceLegacyId === legacyId && candidate.severity === "BLOCKER");
}

async function resetOutput() {
  const target = path.resolve(REHEARSAL_OUTPUT_ROOT);
  if (!target.startsWith(`${path.resolve(process.cwd())}${path.sep}`) || path.basename(target) !== ".migration-rehearsal") throw new Error("Unsafe migration output root.");
  await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true, mode: 0o700 });
}

async function initialCounts(db: PrismaClient) {
  const [artists, tracks, podcasts, releases, releaseTracks, mediaAssets] = await Promise.all([db.artist.count(), db.track.count(), db.podcastEpisode.count(), db.release.count(), db.releaseTrack.count(), db.mediaAsset.count()]);
  return { artists, tracks, podcasts, releases, releaseTracks, mediaAssets };
}

async function seedRehearsal(db: PrismaClient) {
  await db.user.create({ data: { id: ACTOR_ID, name: "Catalogue Migration Rehearsal", email: "migration-rehearsal@local.invalid", emailVerified: true, role: "ADMIN" } });
  await db.label.createMany({ data: LABELS.map((label) => ({ ...label, active: true })) });
}

async function importArtwork(media: RehearsalMediaImporter, analysis: Analysis, issues: MigrationIssueInput[]) {
  const ids = new Map<string, string | null>();
  const groups: Array<[string, RawRow[], string[]]> = [
    ["artists", analysis.catalogue.artists, ["image"]],
    ["tracks", analysis.catalogue.tracks, ["cover_download", "cover_high", "cover_low", "cover_thumbnail_high", "cover_thumbnail_low"]],
    ["releases", analysis.catalogue.releases, ["cover_download", "cover_high", "cover_low", "cover_thumbnail_high", "cover_thumbnail_low"]],
  ];
  for (const [table, rows, fields] of groups) for (const row of rows) {
    const id = integer(row.id); if (!id) continue;
    const source = await resolveArtworkSource(LEGACY_MEDIA_ROOT, row, fields); const key = `${table}:${id}`;
    if (!source) { ids.set(key, null); continue; }
    try { ids.set(key, await media.image(source)); }
    catch { ids.set(key, null); issues.push({ sourceTable: table, sourceLegacyId: id, field: fields[0]!, severity: table === "releases" || row.type === "podcast" ? "BLOCKER" : "WARNING", problem: "Resolved local artwork is not safely decodable.", evidence: path.basename(source), proposedAction: "Replace or repair the local source image before production migration." }); }
  }
  return ids;
}

async function importArtists(db: PrismaClient, analysis: Analysis, artwork: Map<string, string | null>) {
  let imported = 0; let revisions = 0;
  for (const row of analysis.catalogue.artists) {
    const legacyId = integer(row.id); const name = clean(row.name); if (!legacyId || !name || hasBlocker(analysis, "artists", legacyId)) continue;
    const id = artistUuid(legacyId); const revisionId = stableUuid("artist-revision", legacyId);
    const data = { id, legacyId, name, slug: migrationSlug(name, legacyId), shortBio: clean(row.description_short), facebookUrl: normalizeLegacyUrl(row.facebook_url), imageAssetId: artwork.get(`artists:${legacyId}`) ?? null, status: "DRAFT" as const, workingVersion: 1 };
    await db.artist.create({ data });
    await db.artistRevision.create({ data: { id: revisionId, artistId: id, revisionNumber: 1, sourceWorkingVersion: 1, name: data.name, slug: data.slug, shortBio: data.shortBio, facebookUrl: data.facebookUrl, imageAssetId: data.imageAssetId, createdById: ACTOR_ID } });
    await db.artist.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } }); imported += 1; revisions += 1;
  }
  return { imported, revisions };
}

async function importTracksAndPodcasts(db: PrismaClient, analysis: Analysis, artwork: Map<string, string | null>, media: RehearsalMediaImporter) {
  let tracks = 0; let podcasts = 0; let chapters = 0; let revisions = 0;
  for (const row of analysis.catalogue.tracks) {
    const legacyId = integer(row.id); const type = row.type; const title = clean(row.title); const primaryLegacyId = integer(row.artist_id); const mappedLabel = mapLabel(row.label);
    if (!legacyId || !title || !primaryLegacyId || !mappedLabel || hasBlocker(analysis, "tracks", legacyId)) continue;
    const primaryArtistId = artistUuid(primaryLegacyId); const secondaryLegacyId = integer(row.secondary_artist_id); const secondaryArtistId = secondaryLegacyId && secondaryLegacyId !== primaryLegacyId ? artistUuid(secondaryLegacyId) : null;
    const primary = await db.artist.findUnique({ where: { id: primaryArtistId } }); if (!primary) continue;
    const secondary = secondaryArtistId ? await db.artist.findUnique({ where: { id: secondaryArtistId } }) : null;
    const audioAssetId = clean(row.file_id) ? await media.externalAudio(clean(row.file_id)!) : null;
    const artworkAssetId = artwork.get(`tracks:${legacyId}`) ?? null; const duration = parseLegacyDuration(row.duration); const durationMs = duration === undefined ? null : duration;
    if (type === "track") {
      const id = trackUuid(legacyId); const revisionId = stableUuid("track-revision", legacyId); const currentLinks = links(row);
      await db.track.create({ data: { id, legacyId, title, primaryArtistId, secondaryArtistId: secondary?.id ?? null, labelId: labelId(mappedLabel), durationMs, artworkAssetId, audioAssetId, status: "DRAFT", workingVersion: 1, ...currentLinks } });
      await db.trackRevision.create({ data: { id: revisionId, trackId: id, revisionNumber: 1, sourceWorkingVersion: 1, title, primaryArtistId, primaryArtistLegacyId: primary.legacyId, primaryArtistName: primary.name, secondaryArtistId: secondary?.id ?? null, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelId: labelId(mappedLabel), labelName: LABELS.find((label) => label.legacyValue === mappedLabel)!.name, labelLegacyValue: mappedLabel, durationMs, artworkAssetId, audioAssetId, createdById: ACTOR_ID, ...currentLinks } });
      await db.track.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } }); tracks += 1; revisions += 1;
    } else if (type === "podcast") {
      const date = parseLegacyDate(row.date); if (!(date instanceof Date) || !artworkAssetId || !audioAssetId) continue;
      const id = podcastUuid(legacyId); const revisionId = stableUuid("podcast-revision", legacyId); const parsed = analysis.chapters.get(legacyId)!;
      await db.podcastEpisode.create({ data: { id, legacyId, title, primaryArtistId, secondaryArtistId: secondary?.id ?? null, labelId: labelId(mappedLabel), episodeDate: date, durationMs, artworkAssetId, audioAssetId, status: "DRAFT", workingVersion: 1 } });
      if (parsed.rows.length) await db.podcastChapter.createMany({ data: parsed.rows.map((chapter) => ({ id: stableUuid("podcast-chapter", `${legacyId}:${chapter.position}`), episodeId: id, ...chapter })) });
      await db.podcastEpisodeRevision.create({ data: { id: revisionId, episodeId: id, revisionNumber: 1, sourceWorkingVersion: 1, title, primaryArtistId, primaryArtistLegacyId: primary.legacyId, primaryArtistName: primary.name, secondaryArtistId: secondary?.id ?? null, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelId: labelId(mappedLabel), labelName: LABELS.find((label) => label.legacyValue === mappedLabel)!.name, labelLegacyValue: mappedLabel, episodeDate: date, durationMs, artworkAssetId, audioAssetId, createdById: ACTOR_ID } });
      if (parsed.rows.length) await db.podcastChapterRevision.createMany({ data: parsed.rows.map((chapter) => ({ id: stableUuid("podcast-chapter-revision", `${legacyId}:${chapter.position}`), episodeRevisionId: revisionId, sourceChapterId: stableUuid("podcast-chapter", `${legacyId}:${chapter.position}`), ...chapter })) });
      await db.podcastEpisode.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } }); podcasts += 1; chapters += parsed.rows.length; revisions += 1;
    }
  }
  return { tracks, podcasts, chapters, revisions };
}

async function importReleases(db: PrismaClient, analysis: Analysis, artwork: Map<string, string | null>, issues: MigrationIssueInput[]) {
  const importedTrackIds = new Set((await db.track.findMany({ select: { legacyId: true } })).map((row) => row.legacyId));
  const relationGroups = Map.groupBy(analysis.catalogue.releaseTracks, (row) => integer(row.release_id) ?? -1);
  let releases = 0; let releaseTracks = 0; let revisions = 0; let revisionTracks = 0;
  for (const row of analysis.catalogue.releases) {
    const legacyId = integer(row.id); const title = clean(row.title); const primaryLegacyId = integer(row.artist_id); const mappedLabel = mapLabel(row.label); const date = parseLegacyDate(row.date); const artworkAssetId = legacyId ? artwork.get(`releases:${legacyId}`) ?? null : null;
    if (!legacyId || !title || !primaryLegacyId || !mappedLabel || !(date instanceof Date) || !artworkAssetId || hasBlocker(analysis, "releases", legacyId)) continue;
    const primary = await db.artist.findUnique({ where: { id: artistUuid(primaryLegacyId) } }); if (!primary) continue;
    const secondaryLegacyId = integer(row.secondary_artist_id); const secondary = secondaryLegacyId && secondaryLegacyId !== primaryLegacyId ? await db.artist.findUnique({ where: { id: artistUuid(secondaryLegacyId) } }) : null;
    const id = releaseUuid(legacyId); const currentLinks = links(row);
    const candidates = (relationGroups.get(legacyId) ?? []).filter((relation) => { const trackId = integer(relation.track_id); const priority = relation.priority && /^\d+$/.test(relation.priority) ? Number(relation.priority) : -1; return trackId && importedTrackIds.has(trackId) && priority >= 0; }).sort((a, b) => Number(a.priority) - Number(b.priority));
    const valid = []; const seenTracks = new Set<number>(); const seenPositions = new Set<number>();
    for (const relation of candidates) { const trackId = integer(relation.track_id)!; const position = Number(relation.priority); if (seenTracks.has(trackId) || seenPositions.has(position)) continue; seenTracks.add(trackId); seenPositions.add(position); valid.push({ trackId, position }); }
    const canPublish = valid.length > 0;
    await db.release.create({ data: { id, legacyId, title, primaryArtistId: primary.id, secondaryArtistId: secondary?.id ?? null, releaseDate: date, labelId: labelId(mappedLabel), artworkAssetId, status: "DRAFT", workingVersion: 1, ...currentLinks } }); releases += 1;
    if (valid.length) { await db.releaseTrack.createMany({ data: valid.map((relation) => ({ id: stableUuid("release-track", `${legacyId}:${relation.trackId}`), releaseId: id, trackId: trackUuid(relation.trackId), position: relation.position })) }); releaseTracks += valid.length; }
    if (!canPublish) { issues.push({ sourceTable: "releases", sourceLegacyId: legacyId, field: "release_tracks", severity: "BLOCKER", problem: "Release has no valid imported Tracks and remains DRAFT.", evidence: null, proposedAction: "Reconcile ReleaseTrack relations before production migration." }); continue; }
    const revisionId = stableUuid("release-revision", legacyId);
    await db.releaseRevision.create({ data: { id: revisionId, releaseId: id, revisionNumber: 1, sourceWorkingVersion: 1, title, primaryArtistId: primary.id, primaryArtistLegacyId: primary.legacyId, primaryArtistName: primary.name, secondaryArtistId: secondary?.id ?? null, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelId: labelId(mappedLabel), labelName: LABELS.find((label) => label.legacyValue === mappedLabel)!.name, labelLegacyValue: mappedLabel, releaseDate: date, artworkAssetId, createdById: ACTOR_ID, ...currentLinks } });
    const frozen = await db.track.findMany({ where: { legacyId: { in: valid.map((relation) => relation.trackId) } }, select: { legacyId: true, publishedRevisionId: true } }); const byLegacy = new Map(frozen.map((track) => [track.legacyId, track.publishedRevisionId]));
    const frozenRows = valid.filter((relation) => byLegacy.get(relation.trackId)).map((relation) => ({ id: stableUuid("release-revision-track", `${legacyId}:${relation.trackId}`), releaseRevisionId: revisionId, trackRevisionId: byLegacy.get(relation.trackId)!, position: relation.position }));
    if (frozenRows.length !== valid.length) { issues.push({ sourceTable: "releases", sourceLegacyId: legacyId, field: "release_tracks", severity: "BLOCKER", problem: "A Release relation lacks an initial TrackRevision.", evidence: null, proposedAction: "Keep Release unpublished until Track reconciliation." }); await db.release.update({ where: { id }, data: { status: "DRAFT" } }); continue; }
    await db.releaseRevisionTrack.createMany({ data: frozenRows }); await db.release.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } }); revisions += 1; revisionTracks += frozenRows.length;
  }
  return { releases, releaseTracks, revisions, revisionTracks };
}

async function setSequences(db: PrismaClient, analysis: Analysis) {
  const artistMax = Math.max(...analysis.catalogue.artists.map((row) => integer(row.id) ?? 0)); const trackMax = Math.max(...analysis.catalogue.tracks.map((row) => integer(row.id) ?? 0)); const releaseMax = Math.max(...analysis.catalogue.releases.map((row) => integer(row.id) ?? 0));
  await db.$executeRawUnsafe(`SELECT setval('legacy_artist_id_seq', ${artistMax}, true)`);
  await db.$executeRawUnsafe(`SELECT setval('legacy_track_id_seq', ${trackMax}, true)`);
  await db.$executeRawUnsafe(`SELECT setval('legacy_release_id_seq', ${releaseMax}, true)`);
  return { artistNext: artistMax + 1, trackNext: trackMax + 1, releaseNext: releaseMax + 1 };
}

export async function runRehearsal() {
  const databaseUrl = rehearsalDatabaseUrl(); await resetOutput(); await resetRehearsalDatabase(databaseUrl); applyMigrations(databaseUrl);
  const db = migrationClient(databaseUrl);
  try {
    const empty = await initialCounts(db); if (Object.values(empty).some((count) => count !== 0)) throw new Error("Dedicated rehearsal database was not empty after reset."); await seedRehearsal(db);
    const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT); const analysis = await analyzeCatalogue(loaded.sourceSha256, loaded.catalogue, LEGACY_MEDIA_ROOT); const issues = [...analysis.issues];
    const runId = stableUuid("migration-run", loaded.sourceSha256); await db.migrationRun.create({ data: { id: runId, sourceSha256: loaded.sourceSha256 } });
    const media = new RehearsalMediaImporter(db, REHEARSAL_STORAGE_ROOT, ACTOR_ID); const artwork = await importArtwork(media, analysis, issues);
    const artistResult = await importArtists(db, analysis, artwork); const contentResult = await importTracksAndPodcasts(db, analysis, artwork, media); const releaseResult = await importReleases(db, analysis, artwork, issues); const sequences = await setSequences(db, analysis);
    const severity = Object.fromEntries(["BLOCKER", "WARNING", "COMPATIBILITY", "INFORMATIONAL"].map((level) => [level, issues.filter((candidate) => candidate.severity === level).length]));
    const rejectedChapterLines = [...analysis.chapters.values()].flatMap((chapter) => chapter.rejected);
    const chapterReview = Object.fromEntries([...new Set(rejectedChapterLines.map(classifyRejectedChapterLine))].sort().map((classification) => [classification, rejectedChapterLines.filter((line) => classifyRejectedChapterLine(line) === classification).length]));
    const summary = { source: analysis.counts, initialEmptyCounts: empty, imported: { artists: artistResult.imported, tracks: contentResult.tracks, podcasts: contentResult.podcasts, releases: releaseResult.releases, releaseTracks: releaseResult.releaseTracks, podcastChapters: contentResult.chapters, imageAssets: media.imageCount, historicalAudioReferences: media.audioCount, revisions: artistResult.revisions + contentResult.revisions + releaseResult.revisions, releaseRevisionTracks: releaseResult.revisionTracks }, blocked: { artists: analysis.counts.artists - artistResult.imported, tracks: analysis.counts.tracks - contentResult.tracks, podcasts: analysis.counts.podcasts - contentResult.podcasts, releases: analysis.counts.releases - releaseResult.releases, releaseTracks: analysis.counts.releaseTracks - releaseResult.releaseTracks }, severity, labels: analysis.labels, sequences, chapterReview, normalizationRulesVersion: NORMALIZATION_RULES_VERSION, sourceSha256: loaded.sourceSha256 };
    for (let index = 0; index < issues.length; index += 500) await db.migrationIssue.createMany({ data: issues.slice(index, index + 500).map((candidate, offset) => ({ id: stableUuid("migration-issue", `${index + offset}:${candidate.sourceTable}:${candidate.sourceLegacyId}:${candidate.field}:${candidate.problem}`), runId, ...candidate })) });
    await db.migrationRun.update({ where: { id: runId }, data: { completedAt: new Date(), summary: summary as Prisma.InputJsonValue } });
    await writeFile(REHEARSAL_REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), summary, issues }, null, 2), { mode: 0o600 });
    return { summary, issues, runId, databaseUrl };
  } finally { await db.$disconnect(); }
}
