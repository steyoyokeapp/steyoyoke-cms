import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { analyzeCatalogue, classifyRejectedChapterLine, integer, mapLabel, normalizeLegacyUrl, parseLegacyDate, parseLegacyDuration, resolveArtworkSource } from "./analysis";
import { applyMigrations, migrationClient, resetRehearsalDatabase } from "./database";
import { stableUuid, migrationSlug } from "./identity";
import { loadLegacySnapshot } from "./legacy-dump";
import { RehearsalMediaImporter } from "./media";
import { LEGACY_MEDIA_ROOT, LEGACY_SNAPSHOT, REHEARSAL_OUTPUT_ROOT, REHEARSAL_REPORT_PATH, REHEARSAL_STORAGE_ROOT, rehearsalDatabaseUrl } from "./config";
import { LocalStorageProvider, createStorageProvider, type StorageProvider } from "../../src/modules/media/storage";
import { log } from "../../src/lib/logger";
import type { Analysis, MigrationIssueInput, RawRow } from "./types";
import { NORMALIZATION_RULES_VERSION } from "./policy";
import { AppError } from "../../src/lib/errors";
import { checkpoint, conflict, ensureMigrationRun } from "./ownership";
import { finalizeLegacySequences } from "./sequences";
import { selectMigrationScope, type MigrationScope } from "./scope";
import { CANONICAL_LABELS, classifyReleaseTracks, externalAudioInvariantError, matchesExpectedRecord, MIGRATION_ACTOR_ID } from "./safety";
import { reconcileMigrationTarget } from "./compare";
import { assertImportSuccess } from "./quality";

const ACTOR_ID = MIGRATION_ACTOR_ID;
const LABELS = CANONICAL_LABELS;

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

async function seedRehearsal(db: PrismaClient, runId: string) {
  const actorById = await db.user.findUnique({ where: { id: ACTOR_ID } });
  const actorByEmail = await db.user.findUnique({ where: { email: "migration-rehearsal@local.invalid" } });
  if (actorById && (actorById.email !== "migration-rehearsal@local.invalid" || actorById.name !== "Catalogue Migration Rehearsal" || actorById.role !== "ADMIN")) throw new Error("The deterministic migration actor ID conflicts with an unrelated User.");
  if (actorByEmail && actorByEmail.id !== ACTOR_ID) throw new Error("The migration actor email conflicts with an unrelated User.");
  const actorCreated = !actorById;
  if (actorCreated) await db.user.create({ data: { id: ACTOR_ID, name: "Catalogue Migration Rehearsal", email: "migration-rehearsal@local.invalid", emailVerified: true, role: "ADMIN" } });
  await checkpoint(db, runId, "ACTOR", "catalogue-migration", { canonicalId: ACTOR_ID, stage: "READY", status: "COMPLETED", metadata: { createdByRun: actorCreated, email: "migration-rehearsal@local.invalid" } });
  for (const label of LABELS) {
    const [byId, byLegacy, bySlug] = await Promise.all([db.label.findUnique({ where: { id: label.id } }), db.label.findUnique({ where: { legacyValue: label.legacyValue } }), db.label.findUnique({ where: { slug: label.slug } })]);
    const existing = byId ?? byLegacy ?? bySlug;
    if (existing && (existing.id !== label.id || existing.name !== label.name || existing.slug !== label.slug || existing.legacyValue !== label.legacyValue)) throw new Error(`Canonical Label ${label.legacyValue} conflicts with existing target data.`);
    if (!existing) await db.label.create({ data: { ...label, active: true } });
    await checkpoint(db, runId, "LABEL", label.legacyValue, { canonicalId: label.id, stage: "READY", status: "COMPLETED", metadata: { createdByRun: !existing } });
  }
}

const scalarMatch = matchesExpectedRecord;

async function ensureAudit(db: PrismaClient, runId: string, entityType: "ARTIST" | "TRACK" | "PODCAST" | "RELEASE", entityId: string, legacyId: number, action: "CREATE" | "PUBLISH") {
  const id = stableUuid("migration-catalogue-audit", `${runId}:${entityType}:${legacyId}:${action}`);
  const data = { id, actorId: ACTOR_ID, action, metadata: { migrationRunId: runId, historicalReconstruction: true, legacyId } } as const;
  const validate = async (existing: { actorId: string | null; action: string; metadata: unknown; [key: string]: unknown } | null, foreignKey: string, create: () => Promise<unknown>) => {
    const metadata = existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata as Record<string, unknown> : null;
    if (existing && (existing.actorId !== ACTOR_ID || existing.action !== action || existing[foreignKey] !== entityId || metadata?.migrationRunId !== runId || metadata?.historicalReconstruction !== true || metadata?.legacyId !== legacyId)) await conflict(db, runId, `${entityType}_AUDIT`, `${legacyId}:${action}`, `${entityType} ${action} audit conflicts with deterministic migration provenance.`, id);
    if (!existing) await create();
    await checkpoint(db, runId, `${entityType}_AUDIT`, `${legacyId}:${action}`, { canonicalId: id, stage: "RECORDED", status: "COMPLETED", metadata: { createdByRun: !existing } });
  };
  if (entityType === "ARTIST") await validate(await db.auditLog.findUnique({ where: { id } }), "artistId", () => db.auditLog.create({ data: { ...data, artistId: entityId } }));
  if (entityType === "TRACK") await validate(await db.trackAuditLog.findUnique({ where: { id } }), "trackId", () => db.trackAuditLog.create({ data: { ...data, trackId: entityId } }));
  if (entityType === "PODCAST") await validate(await db.podcastAuditLog.findUnique({ where: { id } }), "episodeId", () => db.podcastAuditLog.create({ data: { ...data, episodeId: entityId } }));
  if (entityType === "RELEASE") await validate(await db.releaseAuditLog.findUnique({ where: { id } }), "releaseId", () => db.releaseAuditLog.create({ data: { ...data, releaseId: entityId } }));
}

async function recordFlag(db: PrismaClient, runId: string, entityType: string, sourceIdentity: string, flag: string) {
  const record = await db.migrationRecord.findUnique({ where: { runId_entityType_sourceIdentity: { runId, entityType, sourceIdentity } } });
  return Boolean(record?.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) && record.metadata[flag] === true);
}

async function recordOwned(db: PrismaClient, runId: string, entityType: string, sourceIdentity: string, canonicalId: string, createdByRun: boolean) {
  await checkpoint(db, runId, entityType, sourceIdentity, { canonicalId, stage: "RECONCILED", status: "COMPLETED", metadata: { createdByRun } });
}

async function assertHistoricalImageReady(db: PrismaClient, id: string | null, required: boolean) {
  if (!id) { if (required) throw new Error("Required historical artwork is absent."); return; }
  const asset = await db.mediaAsset.findUnique({ where: { id }, include: { variants: true, processingJob: true } });
  if (!asset || asset.kind !== "IMAGE" || asset.status !== "READY" || asset.processingJob?.status !== "COMPLETED" || asset.variants.length !== 6) throw new Error(`Historical artwork ${id} is not READY with six representations.`);
}

async function assertHistoricalAudio(db: PrismaClient, id: string | null, legacyAudioId: string | null, required: boolean) {
  if (!id || !legacyAudioId) { if (required) throw new Error("Required historical audio identity is absent."); return; }
  const asset = await db.mediaAsset.findUnique({ where: { id }, include: { variants: true, processingJob: true } });
  const invariantError = externalAudioInvariantError(asset, legacyAudioId);
  if (invariantError) throw new Error(`Historical audio ${legacyAudioId} is not verified: ${invariantError}.`);
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
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      ids.set(key, null); issues.push({ sourceTable: table, sourceLegacyId: id, field: fields[0]!, severity: table === "releases" || row.type === "podcast" ? "BLOCKER" : "WARNING", problem: "Resolved local artwork is not safely decodable.", evidence: path.basename(source), proposedAction: "Replace or repair the local source image before production migration." });
    }
  }
  return ids;
}

async function importArtists(db: PrismaClient, analysis: Analysis, artwork: Map<string, string | null>, runId: string) {
  let imported = 0; let revisions = 0;
  for (const row of analysis.catalogue.artists) {
    const legacyId = integer(row.id); const name = clean(row.name); if (!legacyId || !name || hasBlocker(analysis, "artists", legacyId)) continue;
    const id = artistUuid(legacyId); const revisionId = stableUuid("artist-revision", legacyId);
    const data = { id, legacyId, name, slug: migrationSlug(name, legacyId), shortBio: clean(row.description_short), facebookUrl: normalizeLegacyUrl(row.facebook_url), imageAssetId: artwork.get(`artists:${legacyId}`) ?? null, status: "DRAFT" as const, workingVersion: 1 };
    await assertHistoricalImageReady(db, data.imageAssetId, false);
    const existing = await db.artist.findUnique({ where: { id } }); const byLegacy = await db.artist.findUnique({ where: { legacyId } });
    if (existing && !scalarMatch(existing, data)) await conflict(db, runId, "ARTIST", String(legacyId), `Artist ${legacyId} conflicts with deterministic migration identity.`, id);
    if (!existing && byLegacy) await conflict(db, runId, "ARTIST", String(legacyId), `Artist legacy ID ${legacyId} is owned by unrelated record ${byLegacy.id}.`, byLegacy.id);
    if (!existing) await db.$transaction(async (tx) => {
      await tx.artist.create({ data });
      await checkpoint(tx, runId, "ARTIST", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: true } });
    });
    else await checkpoint(db, runId, "ARTIST", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: false } });
    if (await recordFlag(db, runId, "ARTIST", String(legacyId), "createdByRun")) await ensureAudit(db, runId, "ARTIST", id, legacyId, "CREATE");
    const revisionData = { id: revisionId, artistId: id, revisionNumber: 1, sourceWorkingVersion: 1, name: data.name, slug: data.slug, shortBio: data.shortBio, facebookUrl: data.facebookUrl, imageAssetId: data.imageAssetId, createdById: ACTOR_ID };
    const existingRevision = await db.artistRevision.findUnique({ where: { id: revisionId } });
    if (existingRevision && !scalarMatch(existingRevision, revisionData)) await conflict(db, runId, "ARTIST", String(legacyId), `Artist ${legacyId} revision 1 conflicts.`, id);
    if (!existingRevision) await db.artistRevision.create({ data: revisionData });
    await recordOwned(db, runId, "ARTIST_REVISION", String(legacyId), revisionId, !existingRevision);
    await checkpoint(db, runId, "ARTIST", String(legacyId), { canonicalId: id, stage: "REVISION_CREATED", status: "PROCESSING", metadata: { revisionId } });
    const current = await db.artist.findUniqueOrThrow({ where: { id } });
    if (current.publishedRevisionId && current.publishedRevisionId !== revisionId) await conflict(db, runId, "ARTIST", String(legacyId), `Artist ${legacyId} is published to an unrelated revision.`, id);
    if (current.status !== "PUBLISHED" || !current.publishedRevisionId) await db.$transaction(async (tx) => {
      await tx.artist.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } });
      await checkpoint(tx, runId, "ARTIST", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "PROCESSING", metadata: { publishedByRun: true } });
    });
    if (await recordFlag(db, runId, "ARTIST", String(legacyId), "publishedByRun")) await ensureAudit(db, runId, "ARTIST", id, legacyId, "PUBLISH");
    await checkpoint(db, runId, "ARTIST", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "COMPLETED", metadata: { revisionId } }); imported += 1; revisions += 1;
  }
  return { imported, revisions };
}

async function importTracksAndPodcasts(db: PrismaClient, analysis: Analysis, artwork: Map<string, string | null>, media: RehearsalMediaImporter, runId: string) {
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
      const data = { id, legacyId, title, primaryArtistId, secondaryArtistId: secondary?.id ?? null, labelId: labelId(mappedLabel), durationMs, artworkAssetId, audioAssetId, status: "DRAFT" as const, workingVersion: 1, ...currentLinks };
      await assertHistoricalImageReady(db, artworkAssetId, false); await assertHistoricalAudio(db, audioAssetId, clean(row.file_id), false);
      const existing = await db.track.findUnique({ where: { id } }); const byLegacy = await db.track.findUnique({ where: { legacyId } });
      if (existing && !scalarMatch(existing, data)) await conflict(db, runId, "TRACK", String(legacyId), `Track ${legacyId} conflicts with deterministic migration identity.`, id);
      if (!existing && byLegacy) await conflict(db, runId, "TRACK", String(legacyId), `Track legacy ID ${legacyId} is owned by unrelated record ${byLegacy.id}.`, byLegacy.id);
      if (!existing) await db.$transaction(async (tx) => {
        await tx.track.create({ data });
        await checkpoint(tx, runId, "TRACK", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: true } });
      });
      else await checkpoint(db, runId, "TRACK", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: false } });
      if (await recordFlag(db, runId, "TRACK", String(legacyId), "createdByRun")) await ensureAudit(db, runId, "TRACK", id, legacyId, "CREATE");
      const revisionData = { id: revisionId, trackId: id, revisionNumber: 1, sourceWorkingVersion: 1, title, primaryArtistId, primaryArtistLegacyId: primary.legacyId, primaryArtistName: primary.name, secondaryArtistId: secondary?.id ?? null, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelId: labelId(mappedLabel), labelName: LABELS.find((label) => label.legacyValue === mappedLabel)!.name, labelLegacyValue: mappedLabel, durationMs, artworkAssetId, audioAssetId, createdById: ACTOR_ID, ...currentLinks };
      const existingRevision = await db.trackRevision.findUnique({ where: { id: revisionId } });
      if (existingRevision && !scalarMatch(existingRevision, revisionData)) await conflict(db, runId, "TRACK", String(legacyId), `Track ${legacyId} revision 1 conflicts.`, id);
      if (!existingRevision) await db.trackRevision.create({ data: revisionData });
      await recordOwned(db, runId, "TRACK_REVISION", String(legacyId), revisionId, !existingRevision);
      const current = await db.track.findUniqueOrThrow({ where: { id } });
      if (current.publishedRevisionId && current.publishedRevisionId !== revisionId) await conflict(db, runId, "TRACK", String(legacyId), `Track ${legacyId} is published to an unrelated revision.`, id);
      if (current.status !== "PUBLISHED" || !current.publishedRevisionId) await db.$transaction(async (tx) => {
        await tx.track.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } });
        await checkpoint(tx, runId, "TRACK", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "PROCESSING", metadata: { publishedByRun: true } });
      });
      if (await recordFlag(db, runId, "TRACK", String(legacyId), "publishedByRun")) await ensureAudit(db, runId, "TRACK", id, legacyId, "PUBLISH");
      await checkpoint(db, runId, "TRACK", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "COMPLETED", metadata: { revisionId, historicalExternalAudio: Boolean(audioAssetId) } }); tracks += 1; revisions += 1;
    } else if (type === "podcast") {
      const date = parseLegacyDate(row.date); if (!(date instanceof Date) || !artworkAssetId || !audioAssetId) continue;
      const id = podcastUuid(legacyId); const revisionId = stableUuid("podcast-revision", legacyId); const parsed = analysis.chapters.get(legacyId)!;
      const data = { id, legacyId, title, primaryArtistId, secondaryArtistId: secondary?.id ?? null, labelId: labelId(mappedLabel), episodeDate: date, durationMs, artworkAssetId, audioAssetId, status: "DRAFT" as const, workingVersion: 1 };
      await assertHistoricalImageReady(db, artworkAssetId, true); await assertHistoricalAudio(db, audioAssetId, clean(row.file_id), true);
      const existing = await db.podcastEpisode.findUnique({ where: { id } }); const byLegacy = await db.podcastEpisode.findUnique({ where: { legacyId } });
      if (existing && !scalarMatch(existing, data)) await conflict(db, runId, "PODCAST", String(legacyId), `Podcast ${legacyId} conflicts with deterministic migration identity.`, id);
      if (!existing && byLegacy) await conflict(db, runId, "PODCAST", String(legacyId), `Podcast legacy ID ${legacyId} is owned by unrelated record ${byLegacy.id}.`, byLegacy.id);
      if (!existing) await db.$transaction(async (tx) => {
        await tx.podcastEpisode.create({ data });
        await checkpoint(tx, runId, "PODCAST", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: true } });
      });
      else await checkpoint(db, runId, "PODCAST", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: false } });
      if (await recordFlag(db, runId, "PODCAST", String(legacyId), "createdByRun")) await ensureAudit(db, runId, "PODCAST", id, legacyId, "CREATE");
      for (const chapter of parsed.rows) {
        const chapterData = { id: stableUuid("podcast-chapter", `${legacyId}:${chapter.position}`), episodeId: id, ...chapter };
        const currentChapter = await db.podcastChapter.findUnique({ where: { id: chapterData.id } });
        if (currentChapter && !scalarMatch(currentChapter, chapterData)) await conflict(db, runId, "PODCAST", String(legacyId), `Podcast ${legacyId} chapter ${chapter.position} conflicts.`, id);
        if (!currentChapter) await db.podcastChapter.create({ data: chapterData });
        await recordOwned(db, runId, "PODCAST_CHAPTER", `${legacyId}:${chapter.position}`, chapterData.id, !currentChapter);
      }
      await checkpoint(db, runId, "PODCAST", String(legacyId), { canonicalId: id, stage: "CHAPTERS_CREATED", status: "PROCESSING", metadata: { chapterCount: parsed.rows.length } });
      const revisionData = { id: revisionId, episodeId: id, revisionNumber: 1, sourceWorkingVersion: 1, title, primaryArtistId, primaryArtistLegacyId: primary.legacyId, primaryArtistName: primary.name, secondaryArtistId: secondary?.id ?? null, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelId: labelId(mappedLabel), labelName: LABELS.find((label) => label.legacyValue === mappedLabel)!.name, labelLegacyValue: mappedLabel, episodeDate: date, durationMs, artworkAssetId, audioAssetId, createdById: ACTOR_ID };
      const currentRevision = await db.podcastEpisodeRevision.findUnique({ where: { id: revisionId } });
      if (currentRevision && !scalarMatch(currentRevision, revisionData)) await conflict(db, runId, "PODCAST", String(legacyId), `Podcast ${legacyId} revision 1 conflicts.`, id);
      if (!currentRevision) await db.podcastEpisodeRevision.create({ data: revisionData });
      await recordOwned(db, runId, "PODCAST_REVISION", String(legacyId), revisionId, !currentRevision);
      for (const chapter of parsed.rows) {
        const revisionChapterData = { id: stableUuid("podcast-chapter-revision", `${legacyId}:${chapter.position}`), episodeRevisionId: revisionId, sourceChapterId: stableUuid("podcast-chapter", `${legacyId}:${chapter.position}`), ...chapter };
        const currentChapter = await db.podcastChapterRevision.findUnique({ where: { id: revisionChapterData.id } });
        if (currentChapter && !scalarMatch(currentChapter, revisionChapterData)) await conflict(db, runId, "PODCAST", String(legacyId), `Podcast ${legacyId} revision chapter ${chapter.position} conflicts.`, id);
        if (!currentChapter) await db.podcastChapterRevision.create({ data: revisionChapterData });
        await recordOwned(db, runId, "PODCAST_REVISION_CHAPTER", `${legacyId}:${chapter.position}`, revisionChapterData.id, !currentChapter);
      }
      const current = await db.podcastEpisode.findUniqueOrThrow({ where: { id } });
      if (current.publishedRevisionId && current.publishedRevisionId !== revisionId) await conflict(db, runId, "PODCAST", String(legacyId), `Podcast ${legacyId} is published to an unrelated revision.`, id);
      if (current.status !== "PUBLISHED" || !current.publishedRevisionId) await db.$transaction(async (tx) => {
        await tx.podcastEpisode.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } });
        await checkpoint(tx, runId, "PODCAST", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "PROCESSING", metadata: { publishedByRun: true } });
      });
      if (await recordFlag(db, runId, "PODCAST", String(legacyId), "publishedByRun")) await ensureAudit(db, runId, "PODCAST", id, legacyId, "PUBLISH");
      await checkpoint(db, runId, "PODCAST", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "COMPLETED", metadata: { revisionId, chapterCount: parsed.rows.length, historicalExternalAudio: true } }); podcasts += 1; chapters += parsed.rows.length; revisions += 1;
    }
  }
  return { tracks, podcasts, chapters, revisions };
}

async function importReleases(db: PrismaClient, analysis: Analysis, artwork: Map<string, string | null>, issues: MigrationIssueInput[], runId: string) {
  const importedTrackIds = new Set((await db.track.findMany({ select: { legacyId: true } })).map((row) => row.legacyId));
  const acceptedRelations = classifyReleaseTracks(
    analysis.catalogue.releaseTracks,
    new Set(analysis.catalogue.releases.map((row) => integer(row.id)).filter((id): id is number => Boolean(id))),
    new Set(importedTrackIds),
  ).accepted;
  const relationGroups = Map.groupBy(acceptedRelations, (row) => row.releaseLegacyId);
  let releases = 0; let releaseTracks = 0; let revisions = 0; let revisionTracks = 0;
  for (const row of analysis.catalogue.releases) {
    const legacyId = integer(row.id); const title = clean(row.title); const primaryLegacyId = integer(row.artist_id); const mappedLabel = mapLabel(row.label); const date = parseLegacyDate(row.date); const artworkAssetId = legacyId ? artwork.get(`releases:${legacyId}`) ?? null : null;
    if (!legacyId || !title || !primaryLegacyId || !mappedLabel || !(date instanceof Date) || !artworkAssetId || hasBlocker(analysis, "releases", legacyId)) continue;
    const primary = await db.artist.findUnique({ where: { id: artistUuid(primaryLegacyId) } }); if (!primary) continue;
    const secondaryLegacyId = integer(row.secondary_artist_id); const secondary = secondaryLegacyId && secondaryLegacyId !== primaryLegacyId ? await db.artist.findUnique({ where: { id: artistUuid(secondaryLegacyId) } }) : null;
    const id = releaseUuid(legacyId); const currentLinks = links(row);
    const valid = (relationGroups.get(legacyId) ?? []).map((relation) => ({ trackId: relation.trackLegacyId, position: relation.position }));
    const canPublish = valid.length > 0;
    const data = { id, legacyId, title, primaryArtistId: primary.id, secondaryArtistId: secondary?.id ?? null, releaseDate: date, labelId: labelId(mappedLabel), artworkAssetId, status: "DRAFT" as const, workingVersion: 1, ...currentLinks };
    await assertHistoricalImageReady(db, artworkAssetId, true);
    const existing = await db.release.findUnique({ where: { id } }); const existingByLegacy = await db.release.findUnique({ where: { legacyId } });
    if (existing && !scalarMatch(existing, data)) await conflict(db, runId, "RELEASE", String(legacyId), `Release ${legacyId} conflicts with deterministic migration identity.`, id);
    if (!existing && existingByLegacy) await conflict(db, runId, "RELEASE", String(legacyId), `Release legacy ID ${legacyId} is owned by unrelated record ${existingByLegacy.id}.`, existingByLegacy.id);
    if (!existing) await db.$transaction(async (tx) => {
      await tx.release.create({ data });
      await checkpoint(tx, runId, "RELEASE", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: true } });
    });
    else await checkpoint(db, runId, "RELEASE", String(legacyId), { canonicalId: id, stage: "WORKING_CREATED", status: "PROCESSING", metadata: { createdByRun: false } });
    releases += 1;
    if (await recordFlag(db, runId, "RELEASE", String(legacyId), "createdByRun")) await ensureAudit(db, runId, "RELEASE", id, legacyId, "CREATE");
    for (const relation of valid) {
      const relationData = { id: stableUuid("release-track", `${legacyId}:${relation.trackId}`), releaseId: id, trackId: trackUuid(relation.trackId), position: relation.position };
      const current = await db.releaseTrack.findUnique({ where: { id: relationData.id } });
      if (current && !scalarMatch(current, relationData)) await conflict(db, runId, "RELEASE", String(legacyId), `Release ${legacyId} Track ${relation.trackId} relation conflicts.`, id);
      if (!current) {
        const occupied = await db.releaseTrack.findFirst({ where: { releaseId: id, OR: [{ trackId: relationData.trackId }, { position: relation.position }] } });
        if (occupied) await conflict(db, runId, "RELEASE", String(legacyId), `Release ${legacyId} has an unrelated Track or position occupying ${relation.position}.`, id);
        await db.releaseTrack.create({ data: relationData });
      }
      await recordOwned(db, runId, "RELEASE_TRACK", `${legacyId}:${relation.trackId}`, relationData.id, !current);
    }
    releaseTracks += valid.length;
    if (!canPublish) { issues.push({ sourceTable: "releases", sourceLegacyId: legacyId, field: "release_tracks", severity: "BLOCKER", problem: "Release has no valid imported Tracks and remains DRAFT.", evidence: null, proposedAction: "Reconcile ReleaseTrack relations before production migration." }); continue; }
    const revisionId = stableUuid("release-revision", legacyId);
    const revisionData = { id: revisionId, releaseId: id, revisionNumber: 1, sourceWorkingVersion: 1, title, primaryArtistId: primary.id, primaryArtistLegacyId: primary.legacyId, primaryArtistName: primary.name, secondaryArtistId: secondary?.id ?? null, secondaryArtistLegacyId: secondary?.legacyId ?? null, secondaryArtistName: secondary?.name ?? null, labelId: labelId(mappedLabel), labelName: LABELS.find((label) => label.legacyValue === mappedLabel)!.name, labelLegacyValue: mappedLabel, releaseDate: date, artworkAssetId, createdById: ACTOR_ID, ...currentLinks };
    const existingRevision = await db.releaseRevision.findUnique({ where: { id: revisionId } });
    if (existingRevision && !scalarMatch(existingRevision, revisionData)) await conflict(db, runId, "RELEASE", String(legacyId), `Release ${legacyId} revision 1 conflicts.`, id);
    if (!existingRevision) await db.releaseRevision.create({ data: revisionData });
    await recordOwned(db, runId, "RELEASE_REVISION", String(legacyId), revisionId, !existingRevision);
    const frozen = await db.track.findMany({ where: { legacyId: { in: valid.map((relation) => relation.trackId) } }, select: { legacyId: true, publishedRevisionId: true } }); const byLegacy = new Map(frozen.map((track) => [track.legacyId, track.publishedRevisionId]));
    const frozenRows = valid.filter((relation) => byLegacy.get(relation.trackId)).map((relation) => ({ id: stableUuid("release-revision-track", `${legacyId}:${relation.trackId}`), releaseRevisionId: revisionId, trackRevisionId: byLegacy.get(relation.trackId)!, position: relation.position }));
    if (frozenRows.length !== valid.length) { issues.push({ sourceTable: "releases", sourceLegacyId: legacyId, field: "release_tracks", severity: "BLOCKER", problem: "A Release relation lacks an initial TrackRevision.", evidence: null, proposedAction: "Keep Release unpublished until Track reconciliation." }); await db.release.update({ where: { id }, data: { status: "DRAFT" } }); continue; }
    for (const frozenRow of frozenRows) {
      const existingFrozen = await db.releaseRevisionTrack.findUnique({ where: { id: frozenRow.id } });
      if (existingFrozen && !scalarMatch(existingFrozen, frozenRow)) await conflict(db, runId, "RELEASE", String(legacyId), `Release ${legacyId} frozen Track revision conflicts.`, id);
      if (!existingFrozen) await db.releaseRevisionTrack.create({ data: frozenRow });
      await recordOwned(db, runId, "RELEASE_REVISION_TRACK", `${legacyId}:${frozenRow.position}`, frozenRow.id, !existingFrozen);
    }
    const current = await db.release.findUniqueOrThrow({ where: { id } });
    if (current.publishedRevisionId && current.publishedRevisionId !== revisionId) await conflict(db, runId, "RELEASE", String(legacyId), `Release ${legacyId} is published to an unrelated revision.`, id);
    if (current.status !== "PUBLISHED" || !current.publishedRevisionId) await db.$transaction(async (tx) => {
      await tx.release.update({ where: { id }, data: { status: "PUBLISHED", publishedRevisionId: revisionId } });
      await checkpoint(tx, runId, "RELEASE", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "PROCESSING", metadata: { publishedByRun: true } });
    });
    if (await recordFlag(db, runId, "RELEASE", String(legacyId), "publishedByRun")) await ensureAudit(db, runId, "RELEASE", id, legacyId, "PUBLISH");
    await checkpoint(db, runId, "RELEASE", String(legacyId), { canonicalId: id, stage: "PUBLISHED", status: "COMPLETED", metadata: { revisionId, releaseTrackCount: valid.length } }); revisions += 1; revisionTracks += frozenRows.length;
  }
  return { releases, releaseTracks, revisions, revisionTracks };
}

export async function executeImport(databaseUrl: string, storage: StorageProvider, reportPath: string | null, scope: MigrationScope = "full", options: { expectedSourceSha256?: string } = {}) {
  const db = migrationClient(databaseUrl);
  let activeRunId: string | null = null;
  try {
    const empty = await initialCounts(db);
    const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT); const selected = selectMigrationScope(loaded.catalogue, scope); const analysis = await analyzeCatalogue(loaded.sourceSha256, selected.catalogue, LEGACY_MEDIA_ROOT); const issues = [...analysis.issues];
    if (options.expectedSourceSha256 && loaded.sourceSha256 !== options.expectedSourceSha256) throw new Error("The snapshot changed after controlled-import authorization.");
    const run = await ensureMigrationRun(db, loaded.sourceSha256, selected.scopeKey); const runId = run.id; activeRunId = runId;
    await db.migrationRun.update({ where: { id: runId }, data: { completedAt: null } });
    await seedRehearsal(db, runId);
    const media = new RehearsalMediaImporter(db, storage, ACTOR_ID, runId, LEGACY_MEDIA_ROOT); const artwork = await importArtwork(media, analysis, issues);
    await media.processImages();
    const artistResult = await importArtists(db, analysis, artwork, runId); const contentResult = await importTracksAndPodcasts(db, analysis, artwork, media, runId); const releaseResult = await importReleases(db, analysis, artwork, issues, runId);
    const artistMax = Math.max(0, ...analysis.catalogue.artists.map((row) => integer(row.id) ?? 0)); const contentMax = Math.max(0, ...analysis.catalogue.tracks.map((row) => integer(row.id) ?? 0)); const releaseMax = Math.max(0, ...analysis.catalogue.releases.map((row) => integer(row.id) ?? 0));
    const sequences = await finalizeLegacySequences(db, { artist: artistMax, content: contentMax, release: releaseMax });
    const severity = Object.fromEntries(["BLOCKER", "WARNING", "COMPATIBILITY", "INFORMATIONAL"].map((level) => [level, issues.filter((candidate) => candidate.severity === level).length]));
    const rejectedChapterLines = [...analysis.chapters.values()].flatMap((chapter) => chapter.rejected);
    const chapterReview = Object.fromEntries([...new Set(rejectedChapterLines.map(classifyRejectedChapterLine))].sort().map((classification) => [classification, rejectedChapterLines.filter((line) => classifyRejectedChapterLine(line) === classification).length]));
    const summary = { scopeKey: selected.scopeKey, closure: selected.closure, source: analysis.counts, initialEmptyCounts: empty, imported: { artists: artistResult.imported, tracks: contentResult.tracks, podcasts: contentResult.podcasts, releases: releaseResult.releases, releaseTracks: releaseResult.releaseTracks, podcastChapters: contentResult.chapters, imageAssets: media.imageCount, historicalAudioReferences: media.audioCount, revisions: artistResult.revisions + contentResult.revisions + releaseResult.revisions, releaseRevisionTracks: releaseResult.revisionTracks }, blocked: { artists: analysis.counts.artists - artistResult.imported, tracks: analysis.counts.tracks - contentResult.tracks, podcasts: analysis.counts.podcasts - contentResult.podcasts, releases: analysis.counts.releases - releaseResult.releases, releaseTracks: analysis.counts.releaseTracks - releaseResult.releaseTracks }, severity, labels: analysis.labels, sequences, chapterReview, normalizationRulesVersion: NORMALIZATION_RULES_VERSION, sourceSha256: loaded.sourceSha256 };
    for (let index = 0; index < issues.length; index += 500) await db.migrationIssue.createMany({ skipDuplicates: true, data: issues.slice(index, index + 500).map((candidate, offset) => ({ id: stableUuid("migration-issue", `${runId}:${index + offset}:${candidate.sourceTable}:${candidate.sourceLegacyId}:${candidate.field}:${candidate.problem}`), runId, ...candidate })) });
    const acceptedRelations = classifyReleaseTracks(
      analysis.catalogue.releaseTracks,
      new Set(selected.closure.releases),
      new Set(selected.closure.tracks),
    );
    const [failedCheckpoints, conflictingCheckpoints, imageRecords, comparison] = await Promise.all([
      db.migrationRecord.count({ where: { runId, status: "FAILED" } }),
      db.migrationRecord.count({ where: { runId, status: "CONFLICT" } }),
      db.migrationRecord.findMany({ where: { runId, entityType: "IMAGE", canonicalId: { not: null } }, select: { canonicalId: true } }),
      reconcileMigrationTarget(db, storage, analysis, runId),
    ]);
    const imageIds = imageRecords.map((record) => record.canonicalId!);
    const [imageStates, completedImageJobs] = await Promise.all([
      db.mediaAsset.findMany({ where: { id: { in: imageIds } }, include: { variants: true } }),
      db.mediaProcessingJob.count({ where: { mediaAssetId: { in: imageIds }, status: "COMPLETED" } }),
    ]);
    const requiredVariantKeys = new Set(["ORIGINAL", "LEGACY_1440", "LEGACY_1024", "LEGACY_512", "LEGACY_THUMB_256", "LEGACY_THUMB_80"]);
    const incompleteImages = imageIds.length - imageStates.filter((asset) => asset.status === "READY" && asset.variants.length === requiredVariantKeys.size && asset.variants.every((variant) => requiredVariantKeys.has(variant.variantKey))).length;
    const incompleteImageJobs = imageIds.length - completedImageJobs;
    const canonicalCountMismatches: string[] = [];
    const expectedCounts = { artists: analysis.counts.artists, tracks: analysis.counts.tracks, podcasts: analysis.counts.podcasts, releases: analysis.counts.releases, releaseTracks: acceptedRelations.accepted.length };
    for (const kind of ["artists", "tracks", "podcasts", "releases"] as const) if (comparison.compared[kind] !== expectedCounts[kind]) canonicalCountMismatches.push(`${kind} reconciliation expected ${expectedCounts[kind]}, found ${comparison.compared[kind]}`);
    if (releaseResult.releaseTracks !== expectedCounts.releaseTracks || releaseResult.revisionTracks !== expectedCounts.releaseTracks) canonicalCountMismatches.push(`ReleaseTrack reconciliation expected ${expectedCounts.releaseTracks}, found ${releaseResult.releaseTracks}/${releaseResult.revisionTracks}`);
    assertImportSuccess({
      scopeKey: selected.scopeKey, sourceSha256: loaded.sourceSha256,
      analysisBlockers: Number(severity.BLOCKER ?? 0), analysisWarnings: Number(severity.WARNING ?? 0), blocked: summary.blocked,
      expectedOmittedReleaseTracks: acceptedRelations.rejected.length,
      failedCheckpoints, conflictingCheckpoints, incompleteImages, incompleteImageJobs,
      canonicalCountMismatches, comparison,
    });
    await db.migrationRun.update({ where: { id: runId }, data: { completedAt: new Date(), summary: summary as Prisma.InputJsonValue } });
    if (reportPath) await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, issues }, null, 2), { mode: 0o600 });
    return { summary, issues, runId, databaseUrl, comparison };
  } catch (error) {
    if (activeRunId) {
      const message = error instanceof Error ? error.message : "Migration execution failed.";
      try { await db.migrationRun.update({ where: { id: activeRunId }, data: { completedAt: null, summary: { status: "INCOMPLETE", failure: message.slice(0, 500) } } }); } catch { /* Preserve the original migration failure. */ }
    }
    throw error;
  } finally { await db.$disconnect(); }
}

export async function runRehearsal(scope: MigrationScope = "full") {
  const databaseUrl = rehearsalDatabaseUrl(); await resetOutput(); await resetRehearsalDatabase(databaseUrl); applyMigrations(databaseUrl);
  return executeImport(databaseUrl, new LocalStorageProvider(REHEARSAL_STORAGE_ROOT), REHEARSAL_REPORT_PATH, scope);
}

export async function runStagingImport() {
  const databaseUrl = process.env.STAGING_DATABASE_URL;
  if (!databaseUrl) throw new Error("STAGING_DATABASE_URL is required.");
  const target = new URL(databaseUrl);
  if (target.pathname !== "/steyoyoke_cms_staging") throw new Error("Staging import is restricted to the steyoyoke_cms_staging database.");
  if (process.env.STAGING_CONFIRM_NON_PRODUCTION !== "steyoyoke_cms_staging") throw new Error("Set STAGING_CONFIRM_NON_PRODUCTION=steyoyoke_cms_staging after verifying the target is non-production.");
  const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT);
  if (loaded.sourceSha256 !== "180d16528b61f4520cdce86dcc793953dc747804e61d5e61dd019b71a6e48141") throw new Error("Legacy SQL snapshot SHA-256 does not match the approved Phase 12 snapshot.");
  const outputRoot = path.join(process.cwd(), ".staging-migration");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const storage = createStorageProvider(process.env);
  log("info", "staging_migration_start", { sourceSha256: loaded.sourceSha256, storageProvider: storage.kind });
  applyMigrations(databaseUrl);
  const result = await executeImport(databaseUrl, storage, path.join(outputRoot, "quality-report.json"));
  log("info", "staging_migration_complete", {
    runId: result.runId,
    artists: result.summary.imported.artists,
    tracks: result.summary.imported.tracks,
    podcasts: result.summary.imported.podcasts,
    releases: result.summary.imported.releases,
    imageAssets: result.summary.imported.imageAssets,
    audioReferences: result.summary.imported.historicalAudioReferences,
  });
  return result;
}
