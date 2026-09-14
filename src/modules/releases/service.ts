import { ArtistStatus, Prisma, ReleaseStatus, TrackStatus, type Release } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authorization";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { releaseDate, releaseDraftSchema, releaseListSchema, replaceReleaseTracksSchema, publishReleaseSchema, scheduleReleaseSchema, updateReleaseSchema, type ReleaseDraftInput } from "@/modules/releases/schema";
import { serializeLegacyRelease, serializeLegacyReleaseCompleteTrack } from "@/modules/releases/legacy";
import { assertReadyArtwork, auditMediaAttachment } from "@/modules/media/service";

type Tx = Prisma.TransactionClient;
const urlFields = ["spotifyUrl", "beatportUrl", "traxsourceUrl", "bandcampUrl", "appleMusicUrl", "soundcloudUrl"] as const;

function nullable(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function draftData(data: ReturnType<typeof releaseDraftSchema.parse>) {
  return {
    title: data.title, primaryArtistId: data.primaryArtistId, secondaryArtistId: data.secondaryArtistId || null,
    labelId: data.labelId, releaseDate: releaseDate(data.releaseDate),
    artworkAssetId: data.artworkAssetId || null,
    ...Object.fromEntries(urlFields.map((field) => [field, nullable(data[field])])),
  };
}

async function lockRelease(tx: Tx, id: string): Promise<Release> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM releases WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new AppError("Release not found.", 404, "RELEASE_NOT_FOUND");
  const release = await tx.release.findUnique({ where: { id } });
  if (!release) throw new AppError("Release not found.", 404, "RELEASE_NOT_FOUND");
  return release;
}

function assertEditable(release: Release) {
  if (release.status === ReleaseStatus.ARCHIVED) throw new AppError("Restore this Release before editing it.", 409, "RELEASE_ARCHIVED");
}

function assertVersion(release: Release, expected: number) {
  if (release.workingVersion !== expected) throw new AppError("This draft changed after you opened it. Reload before saving.", 409, "WORKING_VERSION_CONFLICT", { currentWorkingVersion: release.workingVersion });
}

async function publicationDependencies(tx: Tx, release: Release) {
  await tx.$queryRaw`SELECT t.id FROM tracks t JOIN release_tracks rt ON rt."trackId"=t.id WHERE rt."releaseId"=${release.id}::uuid ORDER BY t.id FOR SHARE OF t`;
  const [primary, secondary, label, publishedRevision, memberships] = await Promise.all([
    tx.artist.findUnique({ where: { id: release.primaryArtistId }, include: { publishedRevision: true } }),
    release.secondaryArtistId ? tx.artist.findUnique({ where: { id: release.secondaryArtistId }, include: { publishedRevision: true } }) : null,
    tx.label.findUnique({ where: { id: release.labelId } }),
    release.publishedRevisionId ? tx.releaseRevision.findUnique({ where: { id: release.publishedRevisionId } }) : null,
    tx.releaseTrack.findMany({ where: { releaseId: release.id }, include: { track: { include: { publishedRevision: true } } }, orderBy: { position: "asc" } }),
  ]);
  const usableArtist = (artist: typeof primary) => artist?.publishedRevision && (artist.status === ArtistStatus.PUBLISHED || artist.status === ArtistStatus.SCHEDULED);
  if (!usableArtist(primary)) throw new AppError("Primary Artist must have an active published revision.", 422, "PRIMARY_ARTIST_NOT_PUBLISHABLE");
  if (release.secondaryArtistId && !usableArtist(secondary)) throw new AppError("Secondary Artist must have an active published revision.", 422, "SECONDARY_ARTIST_NOT_PUBLISHABLE");
  if (release.secondaryArtistId === release.primaryArtistId) throw new AppError("Primary and Secondary Artist must differ.", 422, "ARTISTS_MUST_DIFFER");
  if (!label) throw new AppError("Label not found.", 422, "LABEL_NOT_FOUND");
  if (!label.active && publishedRevision?.labelId !== label.id) throw new AppError("Inactive Labels cannot be attached to new Release publications.", 422, "LABEL_INACTIVE");
  if (!release.releaseDate) throw new AppError("Release Date is required before publishing.", 422, "RELEASE_DATE_REQUIRED");
  if (!memberships.length) throw new AppError("Add at least one Track before publishing.", 422, "RELEASE_TRACKS_REQUIRED");
  if (memberships.some((membership, position) => membership.position !== position)) throw new AppError("Release Tracks must use contiguous positions.", 422, "RELEASE_TRACKS_NOT_CONTIGUOUS");
  const blocked = memberships.filter(({ track }) => track.status === TrackStatus.ARCHIVED || !track.publishedRevision || (track.status !== TrackStatus.PUBLISHED && track.status !== TrackStatus.SCHEDULED));
  if (blocked.length) {
    throw new AppError(`Release publication is blocked by: ${blocked.map(({ track }) => `${track.title} (#${track.legacyId})`).join(", ")}.`, 422, "TRACK_NOT_PUBLISHABLE", { tracks: blocked.map(({ track }) => ({ id: track.id, legacyId: track.legacyId, title: track.title, status: track.status })) });
  }
  await assertReadyArtwork(tx, release.artworkAssetId, true);
  return { primary: primary!, secondary, label, memberships };
}

async function snapshot(tx: Tx, release: Release, createdById: string) {
  const dependencies = await publicationDependencies(tx, release);
  const latest = await tx.releaseRevision.aggregate({ where: { releaseId: release.id }, _max: { revisionNumber: true } });
  const revision = await tx.releaseRevision.create({ data: {
    id: crypto.randomUUID(), releaseId: release.id, revisionNumber: (latest._max.revisionNumber ?? 0) + 1, sourceWorkingVersion: release.workingVersion,
    title: release.title, primaryArtistId: dependencies.primary.id, primaryArtistLegacyId: dependencies.primary.legacyId, primaryArtistName: dependencies.primary.publishedRevision!.name,
    secondaryArtistId: dependencies.secondary?.id ?? null, secondaryArtistLegacyId: dependencies.secondary?.legacyId ?? null, secondaryArtistName: dependencies.secondary?.publishedRevision?.name ?? null,
    labelId: dependencies.label.id, labelName: dependencies.label.name, labelLegacyValue: dependencies.label.legacyValue, releaseDate: release.releaseDate!,
    artworkAssetId: release.artworkAssetId,
    ...Object.fromEntries(urlFields.map((field) => [field, release[field]])), createdById,
  } });
  await tx.releaseRevisionTrack.createMany({ data: dependencies.memberships.map(({ track }, position) => ({ id: crypto.randomUUID(), releaseRevisionId: revision.id, trackRevisionId: track.publishedRevision!.id, position })) });
  return revision;
}

type ReleaseAuditAction = "CREATE" | "EDIT" | "TRACKS_EDIT" | "REORDER" | "PUBLISH" | "SCHEDULE" | "CANCEL_SCHEDULE" | "UNPUBLISH" | "ARCHIVE" | "RESTORE";
async function audit(tx: Tx, release: Release, actorId: string | null, action: ReleaseAuditAction, metadata: Prisma.InputJsonValue = {}) {
  await tx.releaseAuditLog.create({ data: { releaseId: release.id, actorId, action, metadata: { releaseId: release.id, legacyId: release.legacyId, title: release.title, workingVersion: release.workingVersion, ...(metadata as object) } } });
}

export async function createRelease(actor: Actor, input: ReleaseDraftInput) {
  requirePermission(actor, "release:write"); const data = releaseDraftSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const label = await tx.label.findUnique({ where: { id: data.labelId } });
      if (!label?.active) throw new AppError("Choose an active Label.", 422, "LABEL_INACTIVE");
      const release = await tx.release.create({ data: { id: crypto.randomUUID(), ...draftData(data) } });
      await auditMediaAttachment(tx, actor, null, release.artworkAssetId, { contentType: "RELEASE", contentId: release.id });
      await audit(tx, release, actor.userId, "CREATE"); return release;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw new AppError("Choose existing Artists and Label.", 422, "INVALID_RELATIONSHIP");
    throw error;
  }
}

export async function updateReleaseDraft(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "release:write"); const data = updateReleaseSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const release = await lockRelease(tx, id); assertEditable(release); assertVersion(release, data.expectedWorkingVersion);
      const label = await tx.label.findUnique({ where: { id: data.labelId } });
      if (!label || (!label.active && label.id !== release.labelId)) throw new AppError("Choose an active Label.", 422, "LABEL_INACTIVE");
      const next = draftData(data); if (data.artworkAssetId === undefined) next.artworkAssetId = release.artworkAssetId; const changedFields = Object.keys(next).filter((key) => String(release[key as keyof Release] ?? "") !== String(next[key as keyof typeof next] ?? ""));
      const updated = await tx.release.update({ where: { id }, data: { ...next, workingVersion: { increment: 1 } } });
      await auditMediaAttachment(tx, actor, release.artworkAssetId, updated.artworkAssetId, { contentType: "RELEASE", contentId: id });
      await audit(tx, updated, actor.userId, "EDIT", { changedFields, fromWorkingVersion: release.workingVersion, toWorkingVersion: updated.workingVersion }); return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw new AppError("Choose existing Artists and Label.", 422, "INVALID_RELATIONSHIP");
    throw error;
  }
}

async function replaceTracks(actor: Actor, id: string, input: unknown, action: "TRACKS_EDIT" | "REORDER") {
  requirePermission(actor, "release:write"); const parsed = replaceReleaseTracksSchema.parse(input);
  if (new Set(parsed.trackIds).size !== parsed.trackIds.length) throw new AppError("A Track can appear only once in a Release.", 422, "DUPLICATE_RELEASE_TRACK");
  return prisma.$transaction(async (tx) => {
    const release = await lockRelease(tx, id); assertEditable(release); assertVersion(release, parsed.expectedWorkingVersion);
    const previous = await tx.releaseTrack.findMany({ where: { releaseId: id }, orderBy: { position: "asc" } });
    if (action === "REORDER" && (previous.length !== parsed.trackIds.length || previous.some(({ trackId }) => !parsed.trackIds.includes(trackId)))) throw new AppError("Reordering must retain the current Track membership.", 422, "REORDER_MEMBERSHIP_CHANGED");
    // SHARE locks coordinate membership changes with Track archive's UPDATE lock.
    const found = parsed.trackIds.length ? await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM tracks WHERE id IN (${Prisma.join(parsed.trackIds.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE
    ` : [];
    if (found.some(track => track.status === "ARCHIVED" && !previous.some(member => member.trackId === track.id))) {
      throw new AppError("Deleted Tracks cannot be added to Releases.", 409, "TRACK_ARCHIVED");
    }
    if (found.length !== parsed.trackIds.length) throw new AppError("One or more selected Tracks do not exist.", 422, "TRACK_NOT_FOUND");
    await tx.releaseTrack.deleteMany({ where: { releaseId: id } });
    if (parsed.trackIds.length) await tx.releaseTrack.createMany({ data: parsed.trackIds.map((trackId, position) => ({ id: crypto.randomUUID(), releaseId: id, trackId, position })) });
    const updated = await tx.release.update({ where: { id }, data: { workingVersion: { increment: 1 } } });
    await audit(tx, updated, actor.userId, action, { previousTrackIds: previous.map(({ trackId }) => trackId), trackIds: parsed.trackIds, fromWorkingVersion: release.workingVersion, toWorkingVersion: updated.workingVersion });
    return tx.releaseTrack.findMany({ where: { releaseId: id }, include: { track: true }, orderBy: { position: "asc" } });
  });
}

export async function replaceReleaseTracks(actor: Actor, id: string, input: unknown) { return replaceTracks(actor, id, input, "TRACKS_EDIT"); }
export async function reorderReleaseTracks(actor: Actor, id: string, input: unknown) { return replaceTracks(actor, id, input, "REORDER"); }

export async function publishRelease(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "release:write"); const { expectedWorkingVersion } = publishReleaseSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const release = await lockRelease(tx, id); assertEditable(release); assertVersion(release, expectedWorkingVersion); const revision = await snapshot(tx, release, actor.userId);
    const updated = await tx.release.update({ where: { id }, data: { status: ReleaseStatus.PUBLISHED, publishedRevisionId: revision.id, scheduledRevisionId: null, scheduledFor: null } });
    await audit(tx, updated, actor.userId, "PUBLISH", { revisionId: revision.id, revisionNumber: revision.revisionNumber }); return updated;
  });
}

export async function scheduleRelease(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "release:write"); const { expectedWorkingVersion, scheduledFor } = scheduleReleaseSchema.parse(input);
  if (scheduledFor.getTime() <= Date.now()) throw new AppError("Schedule time must be in the future.", 422, "SCHEDULE_IN_PAST");
  return prisma.$transaction(async (tx) => {
    const release = await lockRelease(tx, id); assertEditable(release); assertVersion(release, expectedWorkingVersion);
    if (release.status === ReleaseStatus.SCHEDULED) throw new AppError("Cancel the current schedule before replacing it.", 409, "ALREADY_SCHEDULED");
    const revision = await snapshot(tx, release, actor.userId);
    const updated = await tx.release.update({ where: { id }, data: { status: ReleaseStatus.SCHEDULED, ...(release.status === ReleaseStatus.UNPUBLISHED ? { publishedRevisionId: null } : {}), scheduledRevisionId: revision.id, scheduledFor } });
    await audit(tx, updated, actor.userId, "SCHEDULE", { revisionId: revision.id, revisionNumber: revision.revisionNumber, scheduledFor: scheduledFor.toISOString(), previousStatus: release.status }); return updated;
  });
}

export async function cancelReleaseSchedule(actor: Actor, id: string) {
  requirePermission(actor, "release:write"); return prisma.$transaction(async (tx) => {
    const release = await lockRelease(tx, id); if (release.status !== ReleaseStatus.SCHEDULED) throw new AppError("Release is not scheduled.", 409, "NOT_SCHEDULED");
    const event = await tx.releaseAuditLog.findFirst({ where: { releaseId: id, action: "SCHEDULE" }, orderBy: { createdAt: "desc" } });
    const previous = (event?.metadata as { previousStatus?: ReleaseStatus } | null)?.previousStatus; const fallback = release.publishedRevisionId ? ReleaseStatus.PUBLISHED : ReleaseStatus.DRAFT;
    const status = previous && previous !== ReleaseStatus.SCHEDULED && previous !== ReleaseStatus.ARCHIVED ? previous : fallback;
    const updated = await tx.release.update({ where: { id }, data: { status, scheduledRevisionId: null, scheduledFor: null } }); await audit(tx, updated, actor.userId, "CANCEL_SCHEDULE", { restoredStatus: status }); return updated;
  });
}

async function scheduledRevisionReady(tx: Tx, revisionId: string) {
  const revision = await tx.releaseRevision.findUnique({ where: { id: revisionId }, include: { artworkAsset: true, primaryArtist: { include: { publishedRevision: true } }, secondaryArtist: { include: { publishedRevision: true } }, tracks: { include: { trackRevision: { include: { track: true } } } } } });
  if (!revision) return false;
  const artistReady = (artist: typeof revision.primaryArtist | null) => artist?.publishedRevision && (artist.status === ArtistStatus.PUBLISHED || artist.status === ArtistStatus.SCHEDULED);
  return Boolean(revision.artworkAsset?.status === "READY" && artistReady(revision.primaryArtist) && (!revision.secondaryArtist || artistReady(revision.secondaryArtist)) && revision.tracks.length && revision.tracks.every(({ trackRevision }) => trackRevision.track.publishedRevisionId && (trackRevision.track.status === TrackStatus.PUBLISHED || trackRevision.track.status === TrackStatus.SCHEDULED)));
}

export async function runScheduledReleasePublication(now = new Date()) {
  const candidates = await prisma.release.findMany({ where: { status: ReleaseStatus.SCHEDULED, scheduledFor: { lte: now } }, select: { id: true }, orderBy: { scheduledFor: "asc" }, take: 100 }); let published = 0;
  for (const candidate of candidates) {
    const didPublish = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM releases WHERE id = ${candidate.id}::uuid AND status = 'SCHEDULED' AND "scheduledFor" <= ${now} FOR UPDATE SKIP LOCKED`;
      if (!rows[0]) return false; const release = await tx.release.findUnique({ where: { id: candidate.id } }); if (!release?.scheduledRevisionId || !(await scheduledRevisionReady(tx, release.scheduledRevisionId))) return false;
      const updated = await tx.release.update({ where: { id: release.id }, data: { status: ReleaseStatus.PUBLISHED, publishedRevisionId: release.scheduledRevisionId, scheduledRevisionId: null, scheduledFor: null } });
      await audit(tx, updated, null, "PUBLISH", { revisionId: release.scheduledRevisionId, scheduled: true }); return true;
    }); if (didPublish) published += 1;
  }
  return { examined: candidates.length, published };
}

export async function unpublishRelease(actor: Actor, id: string) {
  requirePermission(actor, "release:write"); return prisma.$transaction(async (tx) => {
    const release = await lockRelease(tx, id); if (release.status !== ReleaseStatus.PUBLISHED) throw new AppError("Only a published Release can be unpublished.", 409, "NOT_PUBLISHED");
    const updated = await tx.release.update({ where: { id }, data: { status: ReleaseStatus.UNPUBLISHED } }); await audit(tx, updated, actor.userId, "UNPUBLISH"); return updated;
  });
}

export async function archiveRelease(actor: Actor, id: string) {
  requirePermission(actor, "release:write"); return prisma.$transaction(async (tx) => {
    const release = await lockRelease(tx, id); if (release.status === ReleaseStatus.ARCHIVED) return release;
    const updated = await tx.release.update({ where: { id }, data: { status: ReleaseStatus.ARCHIVED, archivedAt: new Date(), scheduledRevisionId: null, scheduledFor: null } }); await audit(tx, updated, actor.userId, "ARCHIVE", { previousStatus: release.status }); return updated;
  });
}

export async function restoreRelease(actor: Actor, id: string) {
  requirePermission(actor, "release:write"); return prisma.$transaction(async (tx) => {
    const release = await lockRelease(tx, id); if (release.status !== ReleaseStatus.ARCHIVED) throw new AppError("Release is not archived.", 409, "NOT_ARCHIVED");
    const event = await tx.releaseAuditLog.findFirst({ where: { releaseId: id, action: "ARCHIVE" }, orderBy: { createdAt: "desc" } });
    const previous = (event?.metadata as { previousStatus?: ReleaseStatus } | null)?.previousStatus;
    const status = previous === ReleaseStatus.UNPUBLISHED ? ReleaseStatus.UNPUBLISHED : release.publishedRevisionId ? ReleaseStatus.PUBLISHED : ReleaseStatus.DRAFT;
    const updated = await tx.release.update({ where: { id }, data: { status, archivedAt: null } }); await audit(tx, updated, actor.userId, "RESTORE", { restoredStatus: status }); return updated;
  });
}

const releaseInclude = {
  primaryArtist: { include: { publishedRevision: true } },
  secondaryArtist: { include: { publishedRevision: true } },
  label: true,
  artworkAsset: true,
  tracks: {
    include: { track: { include: { primaryArtist: true, label: true, publishedRevision: true } } },
    orderBy: { position: "asc" as const },
  },
  publishedRevision: {
    include: { artworkAsset: true, tracks: { include: { trackRevision: { include: { artworkAsset: true, audioAsset: true, track: { select: { legacyId: true } } } } }, orderBy: { position: "asc" as const } } },
  },
  scheduledRevision: {
    include: { artworkAsset: true, tracks: { include: { trackRevision: { include: { artworkAsset: true, audioAsset: true, track: { select: { legacyId: true } } } } }, orderBy: { position: "asc" as const } } },
  },
  revisions: {
    take: 25,
    include: { artworkAsset: true, tracks: { include: { trackRevision: { include: { artworkAsset: true, audioAsset: true, track: { select: { legacyId: true } } } } }, orderBy: { position: "asc" as const } } },
    orderBy: { revisionNumber: "desc" as const },
  },
  auditLogs: { orderBy: { createdAt: "desc" as const }, take: 30, include: { actor: true } },
} satisfies Prisma.ReleaseInclude;

export async function getRelease(actor: Actor, id: string) {
  requirePermission(actor, "release:read"); const release = await prisma.release.findUnique({ where: { id }, include: releaseInclude });
  if (!release) throw new AppError("Release not found.", 404, "RELEASE_NOT_FOUND"); return release;
}

export async function listReleases(actor: Actor, input: unknown = {}) {
  requirePermission(actor, "release:read"); const filters = releaseListSchema.parse(input);
  return prisma.release.findMany({ where: { ...(filters.q ? { title: { contains: filters.q, mode: "insensitive" as const } } : {}), ...(filters.labelId ? { labelId: filters.labelId } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.artistId ? { OR: [{ primaryArtistId: filters.artistId }, { secondaryArtistId: filters.artistId }] } : {}) }, include: { primaryArtist: true, label: true, tracks: { select: { id: true } }, publishedRevision: { select: { sourceWorkingVersion: true } } }, orderBy: [{ updatedAt: "desc" }, { title: "asc" }] });
}

export async function getReleaseFormOptions(actor: Actor, attached?: { primaryArtistId?: string; secondaryArtistId?: string | null; labelId?: string; trackIds?: string[] }) {
  requirePermission(actor, "release:read"); const attachedArtists = [attached?.primaryArtistId, attached?.secondaryArtistId].filter(Boolean) as string[];
  const [artists, labels, tracks] = await Promise.all([
    prisma.artist.findMany({ where: { OR: [{ status: { in: [ArtistStatus.PUBLISHED, ArtistStatus.SCHEDULED] }, publishedRevisionId: { not: null } }, ...(attachedArtists.length ? [{ id: { in: attachedArtists } }] : [])] }, include: { publishedRevision: true }, orderBy: { name: "asc" } }),
    prisma.label.findMany({ where: { OR: [{ active: true }, ...(attached?.labelId ? [{ id: attached.labelId }] : [])] }, orderBy: { name: "asc" } }),
    prisma.track.findMany({ where: { OR: [{ status: { not: TrackStatus.ARCHIVED } }, ...(attached?.trackIds?.length ? [{ id: { in: attached.trackIds } }] : [])] }, include: { primaryArtist: true, label: true, publishedRevision: true }, orderBy: { title: "asc" } }),
  ]);
  return { artists, labels, tracks: tracks.sort((a, b) => Number(Boolean(b.publishedRevision) && (b.status === TrackStatus.PUBLISHED || b.status === TrackStatus.SCHEDULED)) - Number(Boolean(a.publishedRevision) && (a.status === TrackStatus.PUBLISHED || a.status === TrackStatus.SCHEDULED)) || a.title.localeCompare(b.title)) };
}

export async function getReleasePreview(actor: Actor, id: string) {
  return buildReleasePreview(await getRelease(actor, id));
}

export function buildReleasePreview(release: Awaited<ReturnType<typeof getRelease>>) {
  const frozenByTrack = new Map(release.publishedRevision?.tracks.map(({ trackRevision }) => [trackRevision.trackId, trackRevision.id]) ?? []);
  return {
    id: release.id, legacyId: release.legacyId, title: release.title,
    artists: { primary: { id: release.primaryArtist.id, name: release.primaryArtist.name }, secondary: release.secondaryArtist ? { id: release.secondaryArtist.id, name: release.secondaryArtist.name } : null },
    label: { id: release.label.id, name: release.label.name, legacyValue: release.label.legacyValue }, releaseDate: release.releaseDate,
    links: Object.fromEntries(urlFields.map((field) => [field, release[field]])), status: release.status, workingVersion: release.workingVersion,
    artwork: release.artworkAsset ? { mediaAssetId: release.artworkAsset.id, status: release.artworkAsset.status, dimensions: `${release.artworkAsset.width}×${release.artworkAsset.height}`, preview: `/assets/uploads/files/${release.artworkAsset.compatibilityFilename}` } : null,
    tracks: release.tracks.map(({ track, position }) => ({ position, id: track.id, legacyId: track.legacyId, title: track.title, currentPublishedRevisionId: track.publishedRevisionId, currentPublishedRevisionNumber: track.publishedRevision?.revisionNumber ?? null, frozenRevisionId: frozenByTrack.get(track.id) ?? null, changedSinceReleasePublication: frozenByTrack.has(track.id) && frozenByTrack.get(track.id) !== track.publishedRevisionId })),
  };
}

export async function getLegacyReleasePreview(actor: Actor, id: string) {
  return buildLegacyReleasePreview(await getRelease(actor, id));
}

export function buildLegacyReleasePreview(release: Awaited<ReturnType<typeof getRelease>>) {
  if (!release.releaseDate) return { validation: "Release Date is required before publishing.", releases: [] };
  const snapshot = {
    title: release.title, primaryArtistLegacyId: release.primaryArtist.legacyId, primaryArtistName: release.primaryArtist.publishedRevision?.name ?? release.primaryArtist.name,
    secondaryArtistLegacyId: release.secondaryArtist?.legacyId ?? null, secondaryArtistName: release.secondaryArtist?.publishedRevision?.name ?? release.secondaryArtist?.name ?? null,
    releaseDate: release.releaseDate, labelLegacyValue: release.label.legacyValue, bandcampUrl: release.bandcampUrl, appleMusicUrl: release.appleMusicUrl,
    beatportUrl: release.beatportUrl, traxsourceUrl: release.traxsourceUrl, spotifyUrl: release.spotifyUrl, soundcloudUrl: release.soundcloudUrl,
    artworkAsset: release.artworkAsset,
  };
  return { releases: [serializeLegacyRelease(snapshot, release.legacyId, "complete")], base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" };
}

export async function getLegacyReleaseCompletePreview(actor: Actor, id: string) {
  const release = await getRelease(actor, id);
  if (!release.releaseDate) return { releasecomplete: { tracks: [] }, base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" };
  const snapshot = {
    title: release.title, primaryArtistLegacyId: release.primaryArtist.legacyId, primaryArtistName: release.primaryArtist.publishedRevision?.name ?? release.primaryArtist.name,
    secondaryArtistLegacyId: release.secondaryArtist?.legacyId ?? null, secondaryArtistName: release.secondaryArtist?.publishedRevision?.name ?? release.secondaryArtist?.name ?? null,
    releaseDate: release.releaseDate, labelLegacyValue: release.label.legacyValue, bandcampUrl: release.bandcampUrl, appleMusicUrl: release.appleMusicUrl,
    beatportUrl: release.beatportUrl, traxsourceUrl: release.traxsourceUrl, spotifyUrl: release.spotifyUrl, soundcloudUrl: release.soundcloudUrl,
    artworkAsset: release.artworkAsset,
  };
  return { releasecomplete: { "0": serializeLegacyRelease(snapshot, release.legacyId, "complete"), tracks: release.tracks.flatMap(({ track }) => track.publishedRevision ? [serializeLegacyReleaseCompleteTrack(track.publishedRevision, track.legacyId)] : []) }, base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" };
}
