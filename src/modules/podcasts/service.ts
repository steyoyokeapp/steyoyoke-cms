import { ArtistStatus, PodcastStatus, Prisma, type PodcastEpisode, type PodcastEpisodeRevision } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authorization";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { normalizePodcastChapters, podcastDate, podcastDraftSchema, podcastListSchema, publishPodcastSchema, replacePodcastChaptersSchema, schedulePodcastSchema, updatePodcastSchema, type PodcastDraftInput } from "@/modules/podcasts/schema";

type Tx = Prisma.TransactionClient;

function draftData(data: ReturnType<typeof podcastDraftSchema.parse>) {
  return { title: data.title, primaryArtistId: data.primaryArtistId, secondaryArtistId: data.secondaryArtistId || null, labelId: data.labelId, episodeDate: podcastDate(data.episodeDate), durationMs: data.durationMs ?? null };
}

async function lockPodcast(tx: Tx, id: string): Promise<PodcastEpisode> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM podcast_episodes WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new AppError("Podcast not found.", 404, "PODCAST_NOT_FOUND");
  const episode = await tx.podcastEpisode.findUnique({ where: { id } });
  if (!episode) throw new AppError("Podcast not found.", 404, "PODCAST_NOT_FOUND");
  return episode;
}

function assertEditable(episode: PodcastEpisode) {
  if (episode.status === PodcastStatus.ARCHIVED) throw new AppError("Restore this Podcast before editing it.", 409, "PODCAST_ARCHIVED");
}

function assertVersion(episode: PodcastEpisode, expected: number) {
  if (episode.workingVersion !== expected) throw new AppError("This draft changed after you opened it. Reload before saving.", 409, "WORKING_VERSION_CONFLICT", { currentWorkingVersion: episode.workingVersion });
}

async function publicationDependencies(tx: Tx, episode: PodcastEpisode) {
  const [primary, secondary, label, publishedRevision, chapters] = await Promise.all([
    tx.artist.findUnique({ where: { id: episode.primaryArtistId }, include: { publishedRevision: true } }),
    episode.secondaryArtistId ? tx.artist.findUnique({ where: { id: episode.secondaryArtistId }, include: { publishedRevision: true } }) : null,
    tx.label.findUnique({ where: { id: episode.labelId } }),
    episode.publishedRevisionId ? tx.podcastEpisodeRevision.findUnique({ where: { id: episode.publishedRevisionId } }) : null,
    tx.podcastChapter.findMany({ where: { episodeId: episode.id }, orderBy: { position: "asc" } }),
  ]);
  const usable = (artist: typeof primary) => artist?.publishedRevision && (artist.status === ArtistStatus.PUBLISHED || artist.status === ArtistStatus.SCHEDULED);
  if (!usable(primary)) throw new AppError("Primary Artist must have an active published revision.", 422, "PRIMARY_ARTIST_NOT_PUBLISHABLE");
  if (episode.secondaryArtistId && !usable(secondary)) throw new AppError("Secondary Artist must have an active published revision.", 422, "SECONDARY_ARTIST_NOT_PUBLISHABLE");
  if (episode.secondaryArtistId === episode.primaryArtistId) throw new AppError("Primary and Secondary Artist must differ.", 422, "ARTISTS_MUST_DIFFER");
  if (!label) throw new AppError("Label not found.", 422, "LABEL_NOT_FOUND");
  if (!label.active && publishedRevision?.labelId !== label.id) throw new AppError("Inactive Labels cannot be attached to new Podcast publications.", 422, "LABEL_INACTIVE");
  if (!episode.episodeDate) throw new AppError("Episode Date is required before publishing.", 422, "EPISODE_DATE_REQUIRED");
  if (chapters.some((chapter, position) => chapter.position !== position || !chapter.artist.trim() || !chapter.title.trim() || (chapter.durationMs !== null && chapter.durationMs < 0))) {
    throw new AppError("Podcast chapters must be valid and use contiguous positions.", 422, "CHAPTERS_INVALID");
  }
  return { primary: primary!, secondary, label, chapters };
}

async function snapshot(tx: Tx, episode: PodcastEpisode, createdById: string): Promise<PodcastEpisodeRevision> {
  const dependencies = await publicationDependencies(tx, episode);
  const latest = await tx.podcastEpisodeRevision.aggregate({ where: { episodeId: episode.id }, _max: { revisionNumber: true } });
  const revision = await tx.podcastEpisodeRevision.create({ data: {
    id: crypto.randomUUID(), episodeId: episode.id, revisionNumber: (latest._max.revisionNumber ?? 0) + 1, sourceWorkingVersion: episode.workingVersion,
    title: episode.title, primaryArtistId: dependencies.primary.id, primaryArtistLegacyId: dependencies.primary.legacyId, primaryArtistName: dependencies.primary.publishedRevision!.name,
    secondaryArtistId: dependencies.secondary?.id ?? null, secondaryArtistLegacyId: dependencies.secondary?.legacyId ?? null, secondaryArtistName: dependencies.secondary?.publishedRevision?.name ?? null,
    labelId: dependencies.label.id, labelName: dependencies.label.name, labelLegacyValue: dependencies.label.legacyValue,
    episodeDate: episode.episodeDate!, durationMs: episode.durationMs, createdById,
  } });
  if (dependencies.chapters.length) await tx.podcastChapterRevision.createMany({ data: dependencies.chapters.map((chapter) => ({
    id: crypto.randomUUID(), episodeRevisionId: revision.id, sourceChapterId: chapter.id, position: chapter.position, artist: chapter.artist, title: chapter.title, legacyReference: chapter.legacyReference, durationMs: chapter.durationMs,
  })) });
  return revision;
}

type PodcastAuditAction = "CREATE" | "EDIT" | "CHAPTERS_EDIT" | "PUBLISH" | "SCHEDULE" | "CANCEL_SCHEDULE" | "UNPUBLISH" | "ARCHIVE" | "RESTORE";
async function audit(tx: Tx, episode: PodcastEpisode, actorId: string | null, action: PodcastAuditAction, metadata: Prisma.InputJsonValue = {}) {
  await tx.podcastAuditLog.create({ data: { episodeId: episode.id, actorId, action, metadata: { legacyId: episode.legacyId, title: episode.title, workingVersion: episode.workingVersion, ...(metadata as object) } } });
}

export async function createPodcast(actor: Actor, input: PodcastDraftInput) {
  requirePermission(actor, "podcast:write"); const data = podcastDraftSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const label = await tx.label.findUnique({ where: { id: data.labelId } });
      if (!label?.active) throw new AppError("Choose an active Label.", 422, "LABEL_INACTIVE");
      const episode = await tx.podcastEpisode.create({ data: { id: crypto.randomUUID(), ...draftData(data) } });
      await audit(tx, episode, actor.userId, "CREATE"); return episode;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw new AppError("Choose existing Artists and Label.", 422, "INVALID_RELATIONSHIP");
    throw error;
  }
}

export async function updatePodcastDraft(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "podcast:write"); const data = updatePodcastSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const episode = await lockPodcast(tx, id); assertEditable(episode); assertVersion(episode, data.expectedWorkingVersion);
      const label = await tx.label.findUnique({ where: { id: data.labelId } });
      if (!label || (!label.active && label.id !== episode.labelId)) throw new AppError("Choose an active Label.", 422, "LABEL_INACTIVE");
      const next = draftData(data); const changedFields = Object.keys(next).filter((key) => String(episode[key as keyof PodcastEpisode] ?? "") !== String(next[key as keyof typeof next] ?? ""));
      const updated = await tx.podcastEpisode.update({ where: { id }, data: { ...next, workingVersion: { increment: 1 } } });
      await audit(tx, updated, actor.userId, "EDIT", { changedFields, fromWorkingVersion: episode.workingVersion, toWorkingVersion: updated.workingVersion }); return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw new AppError("Choose existing Artists and Label.", 422, "INVALID_RELATIONSHIP");
    throw error;
  }
}

export async function replacePodcastChapters(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "podcast:write"); const parsed = replacePodcastChaptersSchema.parse(input); const chapters = normalizePodcastChapters(parsed.chapters);
  return prisma.$transaction(async (tx) => {
    const episode = await lockPodcast(tx, id); assertEditable(episode); assertVersion(episode, parsed.expectedWorkingVersion);
    const previous = await tx.podcastChapter.findMany({ where: { episodeId: id }, orderBy: { position: "asc" } });
    await tx.podcastChapter.deleteMany({ where: { episodeId: id } });
    if (chapters.length) await tx.podcastChapter.createMany({ data: chapters.map((chapter) => ({ id: crypto.randomUUID(), episodeId: id, ...chapter })) });
    const updated = await tx.podcastEpisode.update({ where: { id }, data: { workingVersion: { increment: 1 } } });
    await audit(tx, updated, actor.userId, "CHAPTERS_EDIT", { previousCount: previous.length, chapterCount: chapters.length, reordered: previous.length === chapters.length && previous.some((chapter, index) => chapter.title !== chapters[index]?.title || chapter.artist !== chapters[index]?.artist) });
    return tx.podcastChapter.findMany({ where: { episodeId: id }, orderBy: { position: "asc" } });
  });
}

export async function publishPodcast(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "podcast:write"); const { expectedWorkingVersion } = publishPodcastSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const episode = await lockPodcast(tx, id); assertEditable(episode); assertVersion(episode, expectedWorkingVersion); const revision = await snapshot(tx, episode, actor.userId);
    const updated = await tx.podcastEpisode.update({ where: { id }, data: { status: PodcastStatus.PUBLISHED, publishedRevisionId: revision.id, scheduledRevisionId: null, scheduledFor: null } });
    await audit(tx, updated, actor.userId, "PUBLISH", { revisionId: revision.id, revisionNumber: revision.revisionNumber }); return updated;
  });
}

export async function schedulePodcast(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "podcast:write"); const { expectedWorkingVersion, scheduledFor } = schedulePodcastSchema.parse(input);
  if (scheduledFor.getTime() <= Date.now()) throw new AppError("Schedule time must be in the future.", 422, "SCHEDULE_IN_PAST");
  return prisma.$transaction(async (tx) => {
    const episode = await lockPodcast(tx, id); assertEditable(episode); assertVersion(episode, expectedWorkingVersion);
    if (episode.status === PodcastStatus.SCHEDULED) throw new AppError("Cancel the current schedule before replacing it.", 409, "ALREADY_SCHEDULED");
    const revision = await snapshot(tx, episode, actor.userId);
    const updated = await tx.podcastEpisode.update({ where: { id }, data: { status: PodcastStatus.SCHEDULED, ...(episode.status === PodcastStatus.UNPUBLISHED ? { publishedRevisionId: null } : {}), scheduledRevisionId: revision.id, scheduledFor } });
    await audit(tx, updated, actor.userId, "SCHEDULE", { revisionId: revision.id, revisionNumber: revision.revisionNumber, scheduledFor: scheduledFor.toISOString(), previousStatus: episode.status }); return updated;
  });
}

export async function cancelPodcastSchedule(actor: Actor, id: string) {
  requirePermission(actor, "podcast:write"); return prisma.$transaction(async (tx) => {
    const episode = await lockPodcast(tx, id); if (episode.status !== PodcastStatus.SCHEDULED) throw new AppError("Podcast is not scheduled.", 409, "NOT_SCHEDULED");
    const event = await tx.podcastAuditLog.findFirst({ where: { episodeId: id, action: "SCHEDULE" }, orderBy: { createdAt: "desc" } });
    const previous = (event?.metadata as { previousStatus?: PodcastStatus } | null)?.previousStatus; const fallback = episode.publishedRevisionId ? PodcastStatus.PUBLISHED : PodcastStatus.DRAFT;
    const status = previous && previous !== PodcastStatus.SCHEDULED && previous !== PodcastStatus.ARCHIVED ? previous : fallback;
    const updated = await tx.podcastEpisode.update({ where: { id }, data: { status, scheduledRevisionId: null, scheduledFor: null } }); await audit(tx, updated, actor.userId, "CANCEL_SCHEDULE", { restoredStatus: status }); return updated;
  });
}

export async function runScheduledPodcastPublication(now = new Date()) {
  const candidates = await prisma.podcastEpisode.findMany({ where: { status: PodcastStatus.SCHEDULED, scheduledFor: { lte: now } }, select: { id: true }, orderBy: { scheduledFor: "asc" }, take: 100 }); let published = 0;
  for (const candidate of candidates) {
    const didPublish = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM podcast_episodes WHERE id = ${candidate.id}::uuid AND status = 'SCHEDULED' AND "scheduledFor" <= ${now} FOR UPDATE SKIP LOCKED`;
      if (!rows[0]) return false; const episode = await tx.podcastEpisode.findUnique({ where: { id: candidate.id } }); if (!episode?.scheduledRevisionId) return false;
      const updated = await tx.podcastEpisode.update({ where: { id: episode.id }, data: { status: PodcastStatus.PUBLISHED, publishedRevisionId: episode.scheduledRevisionId, scheduledRevisionId: null, scheduledFor: null } });
      await audit(tx, updated, null, "PUBLISH", { revisionId: episode.scheduledRevisionId, scheduled: true }); return true;
    }); if (didPublish) published += 1;
  }
  return { examined: candidates.length, published };
}

export async function unpublishPodcast(actor: Actor, id: string) {
  requirePermission(actor, "podcast:write"); return prisma.$transaction(async (tx) => {
    const episode = await lockPodcast(tx, id); if (episode.status !== PodcastStatus.PUBLISHED) throw new AppError("Only a published Podcast can be unpublished.", 409, "NOT_PUBLISHED");
    const updated = await tx.podcastEpisode.update({ where: { id }, data: { status: PodcastStatus.UNPUBLISHED } }); await audit(tx, updated, actor.userId, "UNPUBLISH"); return updated;
  });
}

export async function archivePodcast(actor: Actor, id: string) {
  requirePermission(actor, "podcast:write"); return prisma.$transaction(async (tx) => {
    const episode = await lockPodcast(tx, id); if (episode.status === PodcastStatus.ARCHIVED) return episode;
    const updated = await tx.podcastEpisode.update({ where: { id }, data: { status: PodcastStatus.ARCHIVED, archivedAt: new Date(), scheduledRevisionId: null, scheduledFor: null } });
    await audit(tx, updated, actor.userId, "ARCHIVE", { previousStatus: episode.status }); return updated;
  });
}

export async function restorePodcast(actor: Actor, id: string) {
  requirePermission(actor, "podcast:write"); return prisma.$transaction(async (tx) => {
    const episode = await lockPodcast(tx, id); if (episode.status !== PodcastStatus.ARCHIVED) throw new AppError("Podcast is not archived.", 409, "NOT_ARCHIVED");
    const event = await tx.podcastAuditLog.findFirst({ where: { episodeId: id, action: "ARCHIVE" }, orderBy: { createdAt: "desc" } }); const previous = (event?.metadata as { previousStatus?: PodcastStatus } | null)?.previousStatus;
    const status = previous === PodcastStatus.UNPUBLISHED ? PodcastStatus.UNPUBLISHED : episode.publishedRevisionId ? PodcastStatus.PUBLISHED : PodcastStatus.DRAFT;
    const updated = await tx.podcastEpisode.update({ where: { id }, data: { status, archivedAt: null } }); await audit(tx, updated, actor.userId, "RESTORE", { restoredStatus: status }); return updated;
  });
}

export async function getPodcast(actor: Actor, id: string) {
  requirePermission(actor, "podcast:read"); const episode = await prisma.podcastEpisode.findUnique({ where: { id }, include: {
    primaryArtist: true, secondaryArtist: true, label: true, chapters: { orderBy: { position: "asc" } },
    publishedRevision: { include: { chapters: { orderBy: { position: "asc" } } } }, scheduledRevision: { include: { chapters: { orderBy: { position: "asc" } } } },
    revisions: { orderBy: { revisionNumber: "desc" }, include: { chapters: { orderBy: { position: "asc" } } } }, auditLogs: { orderBy: { createdAt: "desc" }, take: 40, include: { actor: true } },
  } }); if (!episode) throw new AppError("Podcast not found.", 404, "PODCAST_NOT_FOUND"); return episode;
}

export async function listPodcasts(actor: Actor, input: unknown = {}) {
  requirePermission(actor, "podcast:read"); const filters = podcastListSchema.parse(input);
  return prisma.podcastEpisode.findMany({ where: { ...(filters.q ? { title: { contains: filters.q, mode: "insensitive" as const } } : {}), ...(filters.labelId ? { labelId: filters.labelId } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.artistId ? { OR: [{ primaryArtistId: filters.artistId }, { secondaryArtistId: filters.artistId }] } : {}) }, include: { primaryArtist: true, label: true, _count: { select: { chapters: true } }, publishedRevision: { select: { sourceWorkingVersion: true } } }, orderBy: [{ updatedAt: "desc" }, { title: "asc" }] });
}

export async function getPodcastFormOptions(actor: Actor, attached?: { primaryArtistId?: string; secondaryArtistId?: string | null; labelId?: string }) {
  requirePermission(actor, "podcast:read"); const attachedArtists = [attached?.primaryArtistId, attached?.secondaryArtistId].filter(Boolean) as string[];
  const [artists, labels] = await Promise.all([
    prisma.artist.findMany({ where: { OR: [{ status: { in: [ArtistStatus.PUBLISHED, ArtistStatus.SCHEDULED] }, publishedRevisionId: { not: null } }, ...(attachedArtists.length ? [{ id: { in: attachedArtists } }] : [])] }, include: { publishedRevision: true }, orderBy: { name: "asc" } }),
    prisma.label.findMany({ where: { OR: [{ active: true }, ...(attached?.labelId ? [{ id: attached.labelId }] : [])] }, orderBy: { name: "asc" } }),
  ]); return { artists, labels };
}

export async function getPodcastPreview(actor: Actor, id: string) {
  const episode = await getPodcast(actor, id); return { id: episode.id, legacyId: episode.legacyId, title: episode.title, primaryArtist: { id: episode.primaryArtist.id, name: episode.primaryArtist.name }, secondaryArtist: episode.secondaryArtist ? { id: episode.secondaryArtist.id, name: episode.secondaryArtist.name } : null, label: { id: episode.label.id, name: episode.label.name, legacyValue: episode.label.legacyValue }, episodeDate: episode.episodeDate?.toISOString().slice(0, 10) ?? null, durationMs: episode.durationMs, status: episode.status, workingVersion: episode.workingVersion, chapters: episode.chapters.map(({ id: chapterId, position, artist, title, legacyReference, durationMs }) => ({ id: chapterId, position, artist, title, legacyReference, durationMs })) };
}

export async function getLegacyPodcastPreview(actor: Actor, id: string) {
  requirePermission(actor, "podcast:read"); const episode = await prisma.podcastEpisode.findUnique({ where: { id }, include: { publishedRevision: { include: { chapters: { orderBy: { position: "asc" } } } } } });
  if (!episode) throw new AppError("Podcast not found.", 404, "PODCAST_NOT_FOUND"); return episode.publishedRevision && (episode.status === PodcastStatus.PUBLISHED || episode.status === PodcastStatus.SCHEDULED) ? episode : null;
}

const publishedWhere: Prisma.PodcastEpisodeWhereInput = { publishedRevisionId: { not: null }, status: { in: [PodcastStatus.PUBLISHED, PodcastStatus.SCHEDULED] } };
export async function listPublishedPodcastsForLegacy(limit?: number, offset = 0) {
  const [episodes, total] = await prisma.$transaction([prisma.podcastEpisode.findMany({ where: publishedWhere, include: { publishedRevision: { include: { chapters: { orderBy: { position: "asc" } } } } }, orderBy: [{ episodeDate: "desc" }, { legacyId: "desc" }], take: limit, skip: offset }), prisma.podcastEpisode.count({ where: publishedWhere })]); return { episodes, total };
}

export async function getPublishedPodcastForLegacy(legacyId: number) {
  return prisma.podcastEpisode.findFirst({ where: { ...publishedWhere, legacyId }, include: { publishedRevision: { include: { chapters: { orderBy: { position: "asc" } } } } } });
}
