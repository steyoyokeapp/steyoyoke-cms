import { ArtistStatus, Prisma, TrackStatus, type Track, type TrackRevision } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authorization";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { publishTrackSchema, scheduleTrackSchema, trackDraftSchema, trackListSchema, updateTrackSchema, type TrackDraftInput } from "@/modules/tracks/schema";
import { assertReadyArtwork, auditMediaAttachment } from "@/modules/media/service";

type Tx = Prisma.TransactionClient;
const urlFields = ["spotifyUrl", "beatportUrl", "traxsourceUrl", "bandcampUrl", "appleMusicUrl", "soundcloudUrl"] as const;

function nullable(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function draftData(data: ReturnType<typeof trackDraftSchema.parse>) {
  return {
    title: data.title,
    primaryArtistId: data.primaryArtistId,
    secondaryArtistId: data.secondaryArtistId || null,
    labelId: data.labelId,
    durationMs: data.durationMs ?? null,
    artworkAssetId: data.artworkAssetId || null,
    ...Object.fromEntries(urlFields.map((field) => [field, nullable(data[field])])),
  };
}

async function lockTrack(tx: Tx, id: string): Promise<Track> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tracks WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new AppError("Track not found.", 404, "TRACK_NOT_FOUND");
  const track = await tx.track.findUnique({ where: { id } });
  if (!track) throw new AppError("Track not found.", 404, "TRACK_NOT_FOUND");
  return track;
}

function assertEditable(track: Track) {
  if (track.status === TrackStatus.ARCHIVED) throw new AppError("Restore this Track before editing it.", 409, "TRACK_ARCHIVED");
}

function assertVersion(track: Track, expected: number) {
  if (track.workingVersion !== expected) {
    throw new AppError("This draft changed after you opened it. Reload before saving.", 409, "WORKING_VERSION_CONFLICT", { currentWorkingVersion: track.workingVersion });
  }
}

async function publicationDependencies(tx: Tx, track: Track) {
  const [primary, secondary, label, publishedRevision] = await Promise.all([
    tx.artist.findUnique({ where: { id: track.primaryArtistId }, include: { publishedRevision: true } }),
    track.secondaryArtistId ? tx.artist.findUnique({ where: { id: track.secondaryArtistId }, include: { publishedRevision: true } }) : null,
    tx.label.findUnique({ where: { id: track.labelId } }),
    track.publishedRevisionId ? tx.trackRevision.findUnique({ where: { id: track.publishedRevisionId } }) : null,
  ]);
  const usable = (artist: typeof primary) => artist?.publishedRevision && (artist.status === ArtistStatus.PUBLISHED || artist.status === ArtistStatus.SCHEDULED);
  if (!usable(primary)) throw new AppError("Primary Artist must have an active published revision.", 422, "PRIMARY_ARTIST_NOT_PUBLISHABLE");
  if (track.secondaryArtistId && !usable(secondary)) throw new AppError("Secondary Artist must have an active published revision.", 422, "SECONDARY_ARTIST_NOT_PUBLISHABLE");
  if (track.secondaryArtistId === track.primaryArtistId) throw new AppError("Primary and Secondary Artist must differ.", 422, "ARTISTS_MUST_DIFFER");
  if (!label) throw new AppError("Label not found.", 422, "LABEL_NOT_FOUND");
  if (!label.active && publishedRevision?.labelId !== label.id) throw new AppError("Inactive Labels cannot be attached to new Track publications.", 422, "LABEL_INACTIVE");
  return { primary: primary!, secondary, label };
}

async function snapshot(tx: Tx, track: Track, createdById: string): Promise<TrackRevision> {
  await assertReadyArtwork(tx, track.artworkAssetId, false);
  const dependencies = await publicationDependencies(tx, track);
  const latest = await tx.trackRevision.aggregate({ where: { trackId: track.id }, _max: { revisionNumber: true } });
  return tx.trackRevision.create({
    data: {
      id: crypto.randomUUID(), trackId: track.id, revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
      sourceWorkingVersion: track.workingVersion, title: track.title,
      primaryArtistId: dependencies.primary.id, primaryArtistLegacyId: dependencies.primary.legacyId,
      primaryArtistName: dependencies.primary.publishedRevision!.name,
      secondaryArtistId: dependencies.secondary?.id ?? null,
      secondaryArtistLegacyId: dependencies.secondary?.legacyId ?? null,
      secondaryArtistName: dependencies.secondary?.publishedRevision?.name ?? null,
      labelId: dependencies.label.id, labelName: dependencies.label.name, labelLegacyValue: dependencies.label.legacyValue,
      durationMs: track.durationMs,
      artworkAssetId: track.artworkAssetId,
      ...Object.fromEntries(urlFields.map((field) => [field, track[field]])),
      createdById,
    },
  });
}

async function audit(tx: Tx, track: Track, actorId: string | null, action: "CREATE" | "EDIT" | "PUBLISH" | "SCHEDULE" | "CANCEL_SCHEDULE" | "UNPUBLISH" | "ARCHIVE" | "RESTORE", metadata: Prisma.InputJsonValue = {}) {
  await tx.trackAuditLog.create({ data: { trackId: track.id, actorId, action, metadata: { legacyId: track.legacyId, title: track.title, ...(metadata as object) } } });
}

export async function createTrack(actor: Actor, input: TrackDraftInput) {
  requirePermission(actor, "track:write");
  const data = trackDraftSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const label = await tx.label.findUnique({ where: { id: data.labelId } });
      if (!label?.active) throw new AppError("Choose an active Label.", 422, "LABEL_INACTIVE");
      const track = await tx.track.create({ data: { id: crypto.randomUUID(), ...draftData(data) } });
      await auditMediaAttachment(tx, actor, null, track.artworkAssetId, { contentType: "TRACK", contentId: track.id });
      await audit(tx, track, actor.userId, "CREATE");
      return track;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw new AppError("Choose existing Artists and Label.", 422, "INVALID_RELATIONSHIP");
    throw error;
  }
}

export async function updateTrackDraft(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "track:write");
  const data = updateTrackSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const track = await lockTrack(tx, id);
      assertEditable(track); assertVersion(track, data.expectedWorkingVersion);
      const label = await tx.label.findUnique({ where: { id: data.labelId } });
      if (!label || (!label.active && label.id !== track.labelId)) throw new AppError("Choose an active Label.", 422, "LABEL_INACTIVE");
      const next = draftData(data);
      if (data.artworkAssetId === undefined) next.artworkAssetId = track.artworkAssetId;
      const changedFields = Object.keys(next).filter((key) => String(track[key as keyof Track] ?? "") !== String(next[key as keyof typeof next] ?? ""));
      const updated = await tx.track.update({ where: { id }, data: { ...next, workingVersion: { increment: 1 } } });
      await auditMediaAttachment(tx, actor, track.artworkAssetId, updated.artworkAssetId, { contentType: "TRACK", contentId: id });
      await audit(tx, updated, actor.userId, "EDIT", { changedFields, fromWorkingVersion: track.workingVersion, toWorkingVersion: updated.workingVersion });
      return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw new AppError("Choose existing Artists and Label.", 422, "INVALID_RELATIONSHIP");
    throw error;
  }
}

export async function publishTrack(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "track:write");
  const { expectedWorkingVersion } = publishTrackSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const track = await lockTrack(tx, id); assertEditable(track); assertVersion(track, expectedWorkingVersion);
    const revision = await snapshot(tx, track, actor.userId);
    const updated = await tx.track.update({ where: { id }, data: { status: TrackStatus.PUBLISHED, publishedRevisionId: revision.id, scheduledRevisionId: null, scheduledFor: null } });
    await audit(tx, updated, actor.userId, "PUBLISH", { revisionId: revision.id, revisionNumber: revision.revisionNumber });
    return updated;
  });
}

export async function scheduleTrack(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "track:write");
  const { expectedWorkingVersion, scheduledFor } = scheduleTrackSchema.parse(input);
  if (scheduledFor.getTime() <= Date.now()) throw new AppError("Schedule time must be in the future.", 422, "SCHEDULE_IN_PAST");
  return prisma.$transaction(async (tx) => {
    const track = await lockTrack(tx, id); assertEditable(track); assertVersion(track, expectedWorkingVersion);
    if (track.status === TrackStatus.SCHEDULED) throw new AppError("Cancel the current schedule before replacing it.", 409, "ALREADY_SCHEDULED");
    const revision = await snapshot(tx, track, actor.userId);
    const updated = await tx.track.update({ where: { id }, data: { status: TrackStatus.SCHEDULED, ...(track.status === TrackStatus.UNPUBLISHED ? { publishedRevisionId: null } : {}), scheduledRevisionId: revision.id, scheduledFor } });
    await audit(tx, updated, actor.userId, "SCHEDULE", { revisionId: revision.id, revisionNumber: revision.revisionNumber, scheduledFor: scheduledFor.toISOString(), previousStatus: track.status });
    return updated;
  });
}

export async function cancelTrackSchedule(actor: Actor, id: string) {
  requirePermission(actor, "track:write");
  return prisma.$transaction(async (tx) => {
    const track = await lockTrack(tx, id);
    if (track.status !== TrackStatus.SCHEDULED) throw new AppError("Track is not scheduled.", 409, "NOT_SCHEDULED");
    const event = await tx.trackAuditLog.findFirst({ where: { trackId: id, action: "SCHEDULE" }, orderBy: { createdAt: "desc" } });
    const previous = (event?.metadata as { previousStatus?: TrackStatus } | null)?.previousStatus;
    const fallback = track.publishedRevisionId ? TrackStatus.PUBLISHED : TrackStatus.DRAFT;
    const status = previous && previous !== TrackStatus.SCHEDULED && previous !== TrackStatus.ARCHIVED ? previous : fallback;
    const updated = await tx.track.update({ where: { id }, data: { status, scheduledRevisionId: null, scheduledFor: null } });
    await audit(tx, updated, actor.userId, "CANCEL_SCHEDULE", { restoredStatus: status }); return updated;
  });
}

export async function runScheduledTrackPublication(now = new Date()) {
  const candidates = await prisma.track.findMany({ where: { status: TrackStatus.SCHEDULED, scheduledFor: { lte: now } }, select: { id: true }, orderBy: { scheduledFor: "asc" }, take: 100 });
  let published = 0;
  for (const candidate of candidates) {
    const didPublish = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tracks WHERE id = ${candidate.id}::uuid AND status = 'SCHEDULED' AND "scheduledFor" <= ${now} FOR UPDATE SKIP LOCKED`;
      if (!rows[0]) return false;
      const track = await tx.track.findUnique({ where: { id: candidate.id } });
      if (!track?.scheduledRevisionId) return false;
      const revision = await tx.trackRevision.findUnique({ where: { id: track.scheduledRevisionId }, include: { artworkAsset: true } });
      if (!revision || (revision.artworkAssetId && revision.artworkAsset?.status !== "READY")) return false;
      const updated = await tx.track.update({ where: { id: track.id }, data: { status: TrackStatus.PUBLISHED, publishedRevisionId: track.scheduledRevisionId, scheduledRevisionId: null, scheduledFor: null } });
      await audit(tx, updated, null, "PUBLISH", { revisionId: track.scheduledRevisionId, scheduled: true }); return true;
    });
    if (didPublish) published += 1;
  }
  return { examined: candidates.length, published };
}

export async function unpublishTrack(actor: Actor, id: string) {
  requirePermission(actor, "track:write");
  return prisma.$transaction(async (tx) => {
    const track = await lockTrack(tx, id);
    if (track.status !== TrackStatus.PUBLISHED) throw new AppError("Only a published Track can be unpublished.", 409, "NOT_PUBLISHED");
    const updated = await tx.track.update({ where: { id }, data: { status: TrackStatus.UNPUBLISHED } });
    await audit(tx, updated, actor.userId, "UNPUBLISH"); return updated;
  });
}

export async function archiveTrack(actor: Actor, id: string) {
  requirePermission(actor, "track:write");
  return prisma.$transaction(async (tx) => {
    const track = await lockTrack(tx, id); if (track.status === TrackStatus.ARCHIVED) return track;
    const updated = await tx.track.update({ where: { id }, data: { status: TrackStatus.ARCHIVED, archivedAt: new Date(), scheduledRevisionId: null, scheduledFor: null } });
    await audit(tx, updated, actor.userId, "ARCHIVE", { previousStatus: track.status }); return updated;
  });
}

export async function restoreTrack(actor: Actor, id: string) {
  requirePermission(actor, "track:write");
  return prisma.$transaction(async (tx) => {
    const track = await lockTrack(tx, id);
    if (track.status !== TrackStatus.ARCHIVED) throw new AppError("Track is not archived.", 409, "NOT_ARCHIVED");
    const event = await tx.trackAuditLog.findFirst({ where: { trackId: id, action: "ARCHIVE" }, orderBy: { createdAt: "desc" } });
    const previous = (event?.metadata as { previousStatus?: TrackStatus } | null)?.previousStatus;
    const status = previous === TrackStatus.UNPUBLISHED ? TrackStatus.UNPUBLISHED : track.publishedRevisionId ? TrackStatus.PUBLISHED : TrackStatus.DRAFT;
    const updated = await tx.track.update({ where: { id }, data: { status, archivedAt: null } });
    await audit(tx, updated, actor.userId, "RESTORE", { restoredStatus: status }); return updated;
  });
}

export async function getTrack(actor: Actor, id: string) {
  requirePermission(actor, "track:read");
  const track = await prisma.track.findUnique({ where: { id }, include: { primaryArtist: true, secondaryArtist: true, label: true, artworkAsset: true, publishedRevision: { include: { artworkAsset: true } }, scheduledRevision: { include: { artworkAsset: true } }, revisions: { orderBy: { revisionNumber: "desc" }, include: { artworkAsset: true } }, auditLogs: { orderBy: { createdAt: "desc" }, take: 30, include: { actor: true } } } });
  if (!track) throw new AppError("Track not found.", 404, "TRACK_NOT_FOUND"); return track;
}

export async function listTracks(actor: Actor, input: unknown = {}) {
  requirePermission(actor, "track:read"); const filters = trackListSchema.parse(input);
  return prisma.track.findMany({ where: { ...(filters.q ? { title: { contains: filters.q, mode: "insensitive" as const } } : {}), ...(filters.labelId ? { labelId: filters.labelId } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.artistId ? { OR: [{ primaryArtistId: filters.artistId }, { secondaryArtistId: filters.artistId }] } : {}) }, include: { primaryArtist: true, label: true, publishedRevision: { select: { sourceWorkingVersion: true } } }, orderBy: [{ updatedAt: "desc" }, { title: "asc" }] });
}

export async function getTrackFormOptions(actor: Actor, attached?: { primaryArtistId?: string; secondaryArtistId?: string | null; labelId?: string }) {
  requirePermission(actor, "track:read");
  const attachedArtists = [attached?.primaryArtistId, attached?.secondaryArtistId].filter(Boolean) as string[];
  const [artists, labels] = await Promise.all([
    prisma.artist.findMany({ where: { OR: [{ status: { in: [ArtistStatus.PUBLISHED, ArtistStatus.SCHEDULED] }, publishedRevisionId: { not: null } }, ...(attachedArtists.length ? [{ id: { in: attachedArtists } }] : [])] }, include: { publishedRevision: true }, orderBy: { name: "asc" } }),
    prisma.label.findMany({ where: { OR: [{ active: true }, ...(attached?.labelId ? [{ id: attached.labelId }] : [])] }, orderBy: { name: "asc" } }),
  ]);
  return { artists, labels };
}

export async function getTrackPreview(actor: Actor, id: string) {
  const track = await getTrack(actor, id);
  return { id: track.id, legacyId: track.legacyId, title: track.title, primaryArtist: { id: track.primaryArtist.id, name: track.primaryArtist.name }, secondaryArtist: track.secondaryArtist ? { id: track.secondaryArtist.id, name: track.secondaryArtist.name } : null, label: { id: track.label.id, name: track.label.name, legacyValue: track.label.legacyValue }, durationMs: track.durationMs, links: Object.fromEntries(urlFields.map((field) => [field, track[field]])), status: track.status, workingVersion: track.workingVersion };
}

export async function getLegacyTrackPreview(actor: Actor, id: string) {
  requirePermission(actor, "track:read");
  const track = await prisma.track.findUnique({ where: { id }, include: { publishedRevision: { include: { artworkAsset: true } } } });
  if (!track) throw new AppError("Track not found.", 404, "TRACK_NOT_FOUND");
  return track.publishedRevision && (track.status === TrackStatus.PUBLISHED || track.status === TrackStatus.SCHEDULED) ? track : null;
}

export async function listPublishedTracksForLegacy(limit?: number, offset = 0) {
  const where: Prisma.TrackWhereInput = { publishedRevisionId: { not: null }, status: { in: [TrackStatus.PUBLISHED, TrackStatus.SCHEDULED] } };
  const [tracks, total] = await prisma.$transaction([prisma.track.findMany({ where, include: { publishedRevision: { include: { artworkAsset: true } } }, orderBy: { legacyId: "desc" }, take: limit, skip: offset }), prisma.track.count({ where })]);
  return { tracks, total };
}

export async function getPublishedTrackForLegacy(legacyId: number) {
  return prisma.track.findFirst({ where: { legacyId, publishedRevisionId: { not: null }, status: { in: [TrackStatus.PUBLISHED, TrackStatus.SCHEDULED] } }, include: { publishedRevision: { include: { artworkAsset: true } } } });
}
