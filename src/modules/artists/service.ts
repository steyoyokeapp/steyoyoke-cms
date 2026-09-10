import {
  ArtistStatus,
  Prisma,
  type Artist,
  type ArtistRevision,
} from "@/generated/prisma/client";
import type { Actor } from "@/lib/authorization";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  artistDraftSchema,
  artistListSchema,
  publishArtistSchema,
  scheduleArtistSchema,
  updateArtistSchema,
  type ArtistDraftInput,
} from "@/modules/artists/schema";
import { slugify } from "@/modules/artists/slug";

type Tx = Prisma.TransactionClient;

const trimNullable = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

async function lockArtist(tx: Tx, id: string): Promise<Artist> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM artists WHERE id = ${id}::uuid FOR UPDATE
  `;
  if (!locked[0]) throw new AppError("Artist not found.", 404, "ARTIST_NOT_FOUND");
  const artist = await tx.artist.findUnique({ where: { id } });
  if (!artist) throw new AppError("Artist not found.", 404, "ARTIST_NOT_FOUND");
  return artist;
}

function assertEditable(artist: Artist): void {
  if (artist.status === ArtistStatus.ARCHIVED) {
    throw new AppError("Restore this artist before editing it.", 409, "ARTIST_ARCHIVED");
  }
}

function assertVersion(artist: Artist, expectedWorkingVersion: number): void {
  if (artist.workingVersion !== expectedWorkingVersion) {
    throw new AppError(
      "This draft changed after you opened it. Reload before saving.",
      409,
      "WORKING_VERSION_CONFLICT",
      { currentWorkingVersion: artist.workingVersion },
    );
  }
}

async function availableSlug(tx: Tx, requested: string, excludeId?: string): Promise<string> {
  const base = slugify(requested);
  const conflicts = await tx.artist.findMany({
    where: {
      slug: { startsWith: base, mode: "insensitive" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { slug: true },
  });
  const used = new Set(conflicts.map(({ slug }) => slug.toLowerCase()));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new AppError("Could not allocate a unique slug.", 409, "SLUG_EXHAUSTED");
}

async function snapshot(
  tx: Tx,
  artist: Artist,
  createdById: string,
): Promise<ArtistRevision> {
  const latest = await tx.artistRevision.aggregate({
    where: { artistId: artist.id },
    _max: { revisionNumber: true },
  });
  return tx.artistRevision.create({
    data: {
      id: crypto.randomUUID(),
      artistId: artist.id,
      revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
      sourceWorkingVersion: artist.workingVersion,
      name: artist.name,
      slug: artist.slug,
      shortBio: artist.shortBio,
      facebookUrl: artist.facebookUrl,
      createdById,
    },
  });
}

async function audit(
  tx: Tx,
  artistId: string,
  actorId: string | null,
  action: "CREATE" | "EDIT" | "PUBLISH" | "SCHEDULE" | "CANCEL_SCHEDULE" | "UNPUBLISH" | "ARCHIVE" | "RESTORE",
  metadata?: Prisma.InputJsonValue,
) {
  await tx.auditLog.create({
    data: { artistId, actorId, action, ...(metadata ? { metadata } : {}) },
  });
}

export async function createArtist(actor: Actor, input: ArtistDraftInput) {
  requirePermission(actor, "artist:write");
  const data = artistDraftSchema.parse(input);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const slug = await availableSlug(tx, data.slug || data.name);
        const artist = await tx.artist.create({
          data: {
            id: crypto.randomUUID(),
            name: data.name,
            slug,
            shortBio: trimNullable(data.shortBio),
            facebookUrl: trimNullable(data.facebookUrl),
          },
        });
        await audit(tx, artist.id, actor.userId, "CREATE", { legacyId: artist.legacyId });
        return artist;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !["P2002", "P2034"].includes(error.code) || attempt === 3) throw error;
    }
  }
  throw new AppError("Could not create artist after concurrent changes.", 409, "CREATE_CONFLICT");
}

export async function updateArtistDraft(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "artist:write");
  const data = updateArtistSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const artist = await lockArtist(tx, id);
      assertEditable(artist);
      assertVersion(artist, data.expectedWorkingVersion);
      const slug = await availableSlug(tx, data.slug || data.name, artist.id);
      const updated = await tx.artist.update({
        where: { id },
        data: {
          name: data.name,
          slug,
          shortBio: trimNullable(data.shortBio),
          facebookUrl: trimNullable(data.facebookUrl),
          workingVersion: { increment: 1 },
        },
      });
      await audit(tx, id, actor.userId, "EDIT", {
        fromWorkingVersion: artist.workingVersion,
        toWorkingVersion: updated.workingVersion,
      });
      return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("That slug was claimed by another artist. Reload and retry.", 409, "SLUG_CONFLICT");
    }
    throw error;
  }
}

export async function publishArtist(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "artist:write");
  const { expectedWorkingVersion } = publishArtistSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const artist = await lockArtist(tx, id);
    assertEditable(artist);
    assertVersion(artist, expectedWorkingVersion);
    const revision = await snapshot(tx, artist, actor.userId);
    const updated = await tx.artist.update({
      where: { id },
      data: {
        status: ArtistStatus.PUBLISHED,
        publishedRevisionId: revision.id,
        scheduledRevisionId: null,
        scheduledFor: null,
      },
    });
    await audit(tx, id, actor.userId, "PUBLISH", {
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
    });
    return updated;
  });
}

export async function scheduleArtist(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "artist:write");
  const { scheduledFor, expectedWorkingVersion } = scheduleArtistSchema.parse(input);
  if (scheduledFor.getTime() <= Date.now()) {
    throw new AppError("Schedule time must be in the future.", 422, "SCHEDULE_IN_PAST");
  }
  return prisma.$transaction(async (tx) => {
    const artist = await lockArtist(tx, id);
    assertEditable(artist);
    assertVersion(artist, expectedWorkingVersion);
    if (artist.status === ArtistStatus.SCHEDULED) {
      throw new AppError("Cancel the current schedule before replacing it.", 409, "ALREADY_SCHEDULED");
    }
    const revision = await snapshot(tx, artist, actor.userId);
    const updated = await tx.artist.update({
      where: { id },
      data: {
        status: ArtistStatus.SCHEDULED,
        ...(artist.status === ArtistStatus.UNPUBLISHED ? { publishedRevisionId: null } : {}),
        scheduledRevisionId: revision.id,
        scheduledFor,
      },
    });
    await audit(tx, id, actor.userId, "SCHEDULE", {
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      scheduledFor: scheduledFor.toISOString(),
      previousStatus: artist.status,
    });
    return updated;
  });
}

export async function cancelArtistSchedule(actor: Actor, id: string) {
  requirePermission(actor, "artist:write");
  return prisma.$transaction(async (tx) => {
    const artist = await lockArtist(tx, id);
    if (artist.status !== ArtistStatus.SCHEDULED) {
      throw new AppError("Artist is not scheduled.", 409, "NOT_SCHEDULED");
    }
    const scheduledAudit = await tx.auditLog.findFirst({
      where: { artistId: id, action: "SCHEDULE" },
      orderBy: { createdAt: "desc" },
    });
    const previous = (scheduledAudit?.metadata as { previousStatus?: ArtistStatus } | null)?.previousStatus;
    const fallback = artist.publishedRevisionId ? ArtistStatus.PUBLISHED : ArtistStatus.DRAFT;
    const status = previous && previous !== ArtistStatus.SCHEDULED && previous !== ArtistStatus.ARCHIVED
      ? previous
      : fallback;
    const updated = await tx.artist.update({
      where: { id },
      data: { status, scheduledRevisionId: null, scheduledFor: null },
    });
    await audit(tx, id, actor.userId, "CANCEL_SCHEDULE", { restoredStatus: status });
    return updated;
  });
}

export async function runScheduledArtistPublication(now = new Date()) {
  const candidates = await prisma.artist.findMany({
    where: { status: ArtistStatus.SCHEDULED, scheduledFor: { lte: now } },
    select: { id: true },
    orderBy: { scheduledFor: "asc" },
    take: 100,
  });
  let published = 0;
  for (const candidate of candidates) {
    const didPublish = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM artists
        WHERE id = ${candidate.id}::uuid
          AND status = 'SCHEDULED'
          AND "scheduledFor" <= ${now}
        FOR UPDATE SKIP LOCKED
      `;
      if (!rows[0]) return false;
      const artist = await tx.artist.findUnique({ where: { id: candidate.id } });
      if (!artist?.scheduledRevisionId) return false;
      await tx.artist.update({
        where: { id: artist.id },
        data: {
          status: ArtistStatus.PUBLISHED,
          publishedRevisionId: artist.scheduledRevisionId,
          scheduledRevisionId: null,
          scheduledFor: null,
        },
      });
      await audit(tx, artist.id, null, "PUBLISH", {
        revisionId: artist.scheduledRevisionId,
        scheduled: true,
      });
      return true;
    });
    if (didPublish) published += 1;
  }
  return { examined: candidates.length, published };
}

export async function unpublishArtist(actor: Actor, id: string) {
  requirePermission(actor, "artist:write");
  return prisma.$transaction(async (tx) => {
    const artist = await lockArtist(tx, id);
    if (artist.status !== ArtistStatus.PUBLISHED) {
      throw new AppError("Only a published artist can be unpublished.", 409, "NOT_PUBLISHED");
    }
    const updated = await tx.artist.update({ where: { id }, data: { status: ArtistStatus.UNPUBLISHED } });
    await audit(tx, id, actor.userId, "UNPUBLISH");
    return updated;
  });
}

export async function archiveArtist(actor: Actor, id: string) {
  requirePermission(actor, "artist:write");
  return prisma.$transaction(async (tx) => {
    const artist = await lockArtist(tx, id);
    if (artist.status === ArtistStatus.ARCHIVED) return artist;
    const updated = await tx.artist.update({
      where: { id },
      data: {
        status: ArtistStatus.ARCHIVED,
        archivedAt: new Date(),
        scheduledRevisionId: null,
        scheduledFor: null,
      },
    });
    await audit(tx, id, actor.userId, "ARCHIVE", { previousStatus: artist.status });
    return updated;
  });
}

export async function restoreArtist(actor: Actor, id: string) {
  requirePermission(actor, "artist:write");
  return prisma.$transaction(async (tx) => {
    const artist = await lockArtist(tx, id);
    if (artist.status !== ArtistStatus.ARCHIVED) {
      throw new AppError("Artist is not archived.", 409, "NOT_ARCHIVED");
    }
    const archiveAudit = await tx.auditLog.findFirst({
      where: { artistId: id, action: "ARCHIVE" },
      orderBy: { createdAt: "desc" },
    });
    const previous = (archiveAudit?.metadata as { previousStatus?: ArtistStatus } | null)?.previousStatus;
    const status = previous === ArtistStatus.UNPUBLISHED
      ? ArtistStatus.UNPUBLISHED
      : artist.publishedRevisionId
        ? ArtistStatus.PUBLISHED
        : ArtistStatus.DRAFT;
    const updated = await tx.artist.update({
      where: { id },
      data: { status, archivedAt: null },
    });
    await audit(tx, id, actor.userId, "RESTORE", { restoredStatus: status });
    return updated;
  });
}

export async function hardDeleteArtist(actor: Actor, id: string) {
  requirePermission(actor, "artist:hard-delete");
  return prisma.$transaction(async (tx) => {
    const artist = await lockArtist(tx, id);
    const revisionCount = await tx.artistRevision.count({ where: { artistId: id } });
    if (artist.status !== ArtistStatus.DRAFT || revisionCount > 0 || artist.publishedRevisionId) {
      throw new AppError(
        "Only a never-published draft with no revisions can be permanently deleted.",
        409,
        "HARD_DELETE_INELIGIBLE",
      );
    }
    await tx.auditLog.deleteMany({ where: { artistId: id } });
    await tx.artist.delete({ where: { id } });
    return { id };
  });
}

export async function getArtist(actor: Actor, id: string) {
  requirePermission(actor, "artist:read");
  const artist = await prisma.artist.findUnique({
    where: { id },
    include: {
      publishedRevision: true,
      scheduledRevision: true,
      revisions: { orderBy: { revisionNumber: "desc" } },
      auditLogs: { orderBy: { createdAt: "desc" }, take: 30, include: { actor: true } },
    },
  });
  if (!artist) throw new AppError("Artist not found.", 404, "ARTIST_NOT_FOUND");
  return artist;
}

export async function listArtists(actor: Actor, input: unknown = {}) {
  requirePermission(actor, "artist:read");
  const filters = artistListSchema.parse(input);
  return prisma.artist.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.q
        ? {
            OR: [
              { name: { contains: filters.q, mode: "insensitive" as const } },
              { slug: { contains: filters.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
  });
}

export async function getArtistPreview(actor: Actor, id: string) {
  requirePermission(actor, "artist:read");
  const artist = await prisma.artist.findUnique({ where: { id } });
  if (!artist) throw new AppError("Artist not found.", 404, "ARTIST_NOT_FOUND");
  return {
    id: artist.id,
    legacyId: artist.legacyId,
    name: artist.name,
    slug: artist.slug,
    shortBio: artist.shortBio,
    facebookUrl: artist.facebookUrl,
    status: artist.status,
    workingVersion: artist.workingVersion,
  };
}

export async function getLegacyArtistPreview(actor: Actor, id: string) {
  requirePermission(actor, "artist:read");
  const artist = await prisma.artist.findUnique({
    where: { id },
    include: { publishedRevision: true },
  });
  if (!artist) throw new AppError("Artist not found.", 404, "ARTIST_NOT_FOUND");
  return artist.publishedRevision
    ? { legacyId: artist.legacyId, ...artist.publishedRevision }
    : null;
}

export async function listPublishedArtistsForLegacy() {
  return prisma.artist.findMany({
    where: {
      publishedRevisionId: { not: null },
      status: { in: [ArtistStatus.PUBLISHED, ArtistStatus.SCHEDULED] },
    },
    include: { publishedRevision: true },
    orderBy: { legacyId: "asc" },
  });
}

export async function getPublishedArtistForLegacy(legacyId: number) {
  return prisma.artist.findFirst({
    where: {
      legacyId,
      publishedRevisionId: { not: null },
      status: { in: [ArtistStatus.PUBLISHED, ArtistStatus.SCHEDULED] },
    },
    include: { publishedRevision: true },
  });
}
