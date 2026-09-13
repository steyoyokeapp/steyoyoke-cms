import crypto from "node:crypto";
import type { AuditAction, MediaKind, Prisma } from "@/generated/prisma/client";
import { MediaStatus } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authorization";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { log, logSafeError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { inspectImage } from "@/modules/media/image";
import { processAudio } from "@/modules/media/audio";
import { mediaStorage, type StorageProvider } from "@/modules/media/storage";

import { parseMediaBrowse, type MediaBrowseState } from "@/modules/media/browse";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type Db = Prisma.TransactionClient | typeof prisma;

type UploadDiagnostics = { requestId?: string; requestStartedAtMs?: number; parseMs?: number };

const milliseconds = (value: number) => Math.round(value * 100) / 100;

export async function createAndProcessImage(actor: Actor, file: { name: string; bytes: Buffer }, storage: StorageProvider = mediaStorage, diagnostics: UploadDiagnostics = {}) {
  requirePermission(actor, "media:upload");
  const uploadStartedAtMs = diagnostics.requestStartedAtMs ?? performance.now();
  const id = crypto.randomUUID();
  let failureKind = "validation";
  let failureStage = "inspect_source";
  let assetCreated = false;
  let sourceStored = false;
  let sourceStorageKey: string | null = null;
  try {
    const inspected = await inspectImage(file.bytes);
    const outputExtension = inspected.hasAlpha ? "png" : "jpg";
    const outputMimeType = inspected.hasAlpha ? "image/png" : "image/jpeg";
    const sourceExtension = inspected.sourceFormat === "jpeg" ? "jpg" : inspected.sourceFormat;
    sourceStorageKey = `images/${id}/source.${sourceExtension}`;
    const compatibilityFilename = `${id}.${outputExtension}`;
    failureKind = "database"; failureStage = "create_media_asset";
    const dbCreateStartedAtMs = performance.now();
    const asset = await prisma.mediaAsset.create({ data: {
      id, kind: "IMAGE", status: "PROCESSING", provider: storage.kind, sourceStorageKey, compatibilityFilename,
      originalFilename: file.name.slice(0, 255) || "upload", mimeType: outputMimeType, byteSize: file.bytes.length,
      sha256Checksum: inspected.sourceChecksum, width: inspected.sourceWidth, height: inspected.sourceHeight, createdById: actor.userId,
    }, include: { variants: true, createdBy: { select: { id: true, name: true } } } });
    assetCreated = true;
    const dbCreateMs = performance.now() - dbCreateStartedAtMs;
    failureKind = "storage"; failureStage = "write_source";
    const sourceWriteStartedAtMs = performance.now();
    await storage.put(sourceStorageKey, file.bytes);
    sourceStored = true;
    const sourceWriteMs = performance.now() - sourceWriteStartedAtMs;
    failureKind = "database"; failureStage = "enqueue_processing";
    const enqueueStartedAtMs = performance.now();
    await prisma.$transaction(async (tx) => {
      await tx.mediaProcessingJob.create({ data: { mediaAssetId: id } });
      await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_UPLOAD", metadata: { kind: "IMAGE", status: "PROCESSING", byteSize: file.bytes.length } } });
    });
    const enqueueMs = performance.now() - enqueueStartedAtMs;
    log("info", "media_image_ingest_profile", {
      requestId: diagnostics.requestId, operation: "image ingest", storageProvider: storage.kind,
      totalMs: milliseconds(performance.now() - uploadStartedAtMs), parseMs: milliseconds(diagnostics.parseMs ?? 0),
      validationMs: milliseconds(inspected.inspectionMs), dbCreateMs: milliseconds(dbCreateMs), sourceWriteMs: milliseconds(sourceWriteMs),
      enqueueMs: milliseconds(enqueueMs), inputByteSize: file.bytes.length, inputWidth: inspected.sourceWidth, inputHeight: inspected.sourceHeight,
    });
    return asset;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (assetCreated) {
      const cleanup = await Promise.allSettled([
        ...(!sourceStored && sourceStorageKey ? [storage.delete(sourceStorageKey)] : []),
        prisma.mediaAsset.update({ where: { id }, data: { status: "FAILED", failureReason: sourceStored ? "Image processing could not be queued." : "Image source ingest failed." } }),
      ]);
      const cleanupFailure = cleanup.find((result) => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") logSafeError("media_image_ingest_cleanup_failed", cleanupFailure.reason, { requestId: diagnostics.requestId, operation: "image ingest", mediaAssetId: id, storageProvider: storage.kind });
    }
    logSafeError("media_image_upload_failed", error, { requestId: diagnostics.requestId, operation: "image upload", failureKind, failureStage, mediaAssetId: id, storageProvider: storage.kind });
    throw new AppError("Image upload failed cleanly.", 422, "IMAGE_UPLOAD_FAILED");
  }
}

export async function createAndProcessAudio(actor: Actor, file: { name: string; bytes: Buffer }, storage: StorageProvider = mediaStorage) {
  requirePermission(actor, "media:upload"); const id = crypto.randomUUID(); const legacyAudioId = crypto.randomUUID();
  try {
    const processed = await processAudio(file.bytes); const sourceStorageKey = `audio/${id}/source.${processed.extension}`;
    const asset = await prisma.mediaAsset.create({ data: { id, kind: "AUDIO", status: "PROCESSING", provider: storage.kind, sourceStorageKey, compatibilityFilename: null, legacyAudioId, originalFilename: file.name.slice(0, 255) || "audio.mp3", mimeType: processed.mimeType, byteSize: file.bytes.length, sha256Checksum: processed.sha256Checksum, width: null, height: null, durationMs: processed.durationMs, createdById: actor.userId } });
    try {
      await storage.put(sourceStorageKey, file.bytes);
      return await prisma.$transaction(async (tx) => {
        const ready = await tx.mediaAsset.update({ where: { id }, data: { status: "READY", unreferencedAt: new Date() }, include: { variants: true, createdBy: { select: { id: true, name: true } } } });
        await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_UPLOAD", metadata: { kind: "AUDIO", legacyAudioId, originalFilename: ready.originalFilename, byteSize: ready.byteSize, durationMs: ready.durationMs } } }); return ready;
      });
    } catch (error) { await storage.delete(sourceStorageKey); await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED", failureReason: "Audio local storage failed." } }); throw error; }
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError("Audio upload failed cleanly.", 422, "AUDIO_UPLOAD_FAILED"); }
}

export async function getMediaAsset(actor: Actor, id: string) {
  requirePermission(actor, "media:read");
  const asset = await prisma.mediaAsset.findUnique({ where: { id }, include: { processingJob: { select: { status: true } }, variants: { orderBy: { variantKey: "asc" } }, createdBy: { select: { id: true, name: true } } } });
  if (!asset) throw new AppError("Media asset not found.", 404, "MEDIA_NOT_FOUND");
  const references = await getMediaReferences(actor, id);
  return { ...asset, references, referenceCount: references.length };
}

export async function readMediaSource(actor: Actor, id: string, storage: StorageProvider = mediaStorage) {
  requirePermission(actor, "media:read");
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || !asset.sourceStorageKey || asset.provider !== storage.kind) throw new AppError("Media source not found.", 404, "MEDIA_SOURCE_NOT_FOUND");
  const extension = asset.sourceStorageKey.split(".").at(-1)?.toLowerCase();
  const sourceMimeType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : asset.mimeType ?? "application/octet-stream";
  return { bytes: await storage.read(asset.sourceStorageKey), mimeType: sourceMimeType };
}

export async function retryImageProcessing(actor: Actor, id: string) {
  requirePermission(actor, "media:upload");
  return prisma.$transaction(async (tx) => {
    const asset = await tx.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.kind !== "IMAGE") throw new AppError("Image asset not found.", 404, "MEDIA_NOT_FOUND");
    if (asset.status !== "FAILED" || !asset.sourceStorageKey) throw new AppError("Only failed image processing can be retried.", 409, "MEDIA_RETRY_INVALID");
    await tx.mediaProcessingJob.upsert({
      where: { mediaAssetId: id },
      create: { mediaAssetId: id },
      update: { status: "PENDING", attempts: 0, availableAt: new Date(), lockedAt: null, completedAt: null, lastError: null },
    });
    const processing = await tx.mediaAsset.update({ where: { id }, data: { status: "PROCESSING", failureReason: null }, include: { processingJob: { select: { status: true } }, variants: { orderBy: { variantKey: "asc" } }, createdBy: { select: { id: true, name: true } } } });
    await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_RETRY", metadata: { previousStatus: "FAILED" } } });
    return processing;
  });
}

// Offer eligible choices plus the attached asset, which must remain visible even if unavailable.
export async function listMediaOptions(actor: Actor, kind: MediaKind, selectedId?: string | null, db: Db = prisma) {
  requirePermission(actor, "media:read");
  return db.mediaAsset.findMany({ where: { kind, OR: [
    { status: { in: kind === "IMAGE" ? ["READY"] : ["READY", "EXTERNAL"] } },
    ...(selectedId ? [{ id: selectedId }] : []),
  ] }, select: {
    id: true, originalFilename: true, compatibilityFilename: true, legacyAudioId: true,
    width: true, height: true, durationMs: true, status: true,
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

export async function listMediaAssets(actor: Actor, options: Partial<MediaBrowseState> & { limit?: number } = {}, db: Db = prisma) {
  requirePermission(actor, "media:read");
  const { view, kind, page: requestedPage } = parseMediaBrowse(new URLSearchParams({
    view: options.view ?? "ACTIVE", kind: options.kind ?? "ALL", page: String(options.page ?? 1),
  }));
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(50, options.limit!)) : 50;
  const kindWhere = kind === "ALL" ? {} : { kind };
  const groups = await db.mediaAsset.groupBy({ by: ["status"], where: kindWhere, _count: { _all: true } });
  const counts = { active: 0, retired: 0 };
  for (const group of groups) counts[group.status === "RETIRED" ? "retired" : "active"] += group._count._all;
  const total = view === "RETIRED" ? counts.retired : counts.active;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, pageCount);
  const assets = await db.mediaAsset.findMany({
    where: { ...kindWhere, status: view === "RETIRED" ? "RETIRED" : { not: "RETIRED" } },
    skip: (page - 1) * limit, take: limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true, kind: true, provider: true, status: true, originalFilename: true, legacyAudioId: true,
      mimeType: true, byteSize: true, width: true, height: true, durationMs: true, compatibilityFilename: true,
      sha256Checksum: true, sourceStorageKey: true, failureReason: true, retiredAt: true, createdAt: true,
      createdBy: { select: { id: true, name: true } }, processingJob: { select: { status: true } },
      variants: { where: { variantKey: "LEGACY_THUMB_256" }, select: {
        variantKey: true, width: true, height: true, byteSize: true, sha256Checksum: true, storageKey: true,
      } },
      // Prisma folds these relation counts into the page query. No reference rows are materialized.
      _count: { select: {
        artistImages: true, artistRevisionImages: true, trackArtwork: true, trackRevisionArtwork: true,
        trackAudio: true, trackRevisionAudio: true, podcastArtwork: true, podcastRevisionArtwork: true,
        podcastAudio: true, podcastRevisionAudio: true, releaseArtwork: true, releaseRevisionArtwork: true,
      } },
    },
  });
  return { items: assets.map(({ _count, ...asset }) => ({ ...asset, referenceCount: Object.values(_count).reduce((sum, count) => sum + count, 0) })),
    total, page, pageCount, limit, counts };
}

async function referenceRows(db: Db, id: string) {
  const [artists, artistRevisions, tracks, trackRevisions, trackAudio, trackRevisionAudio, podcasts, podcastRevisions, podcastAudio, podcastRevisionAudio, releases, releaseRevisions] = await Promise.all([
    db.artist.findMany({ where: { imageAssetId: id }, select: { id: true, name: true } }), db.artistRevision.findMany({ where: { imageAssetId: id }, select: { id: true, artistId: true, revisionNumber: true } }),
    db.track.findMany({ where: { artworkAssetId: id }, select: { id: true, title: true } }), db.trackRevision.findMany({ where: { artworkAssetId: id }, select: { id: true, trackId: true, revisionNumber: true } }),
    db.track.findMany({ where: { audioAssetId: id }, select: { id: true, title: true } }), db.trackRevision.findMany({ where: { audioAssetId: id }, select: { id: true, trackId: true, revisionNumber: true } }),
    db.podcastEpisode.findMany({ where: { artworkAssetId: id }, select: { id: true, title: true } }), db.podcastEpisodeRevision.findMany({ where: { artworkAssetId: id }, select: { id: true, episodeId: true, revisionNumber: true } }),
    db.podcastEpisode.findMany({ where: { audioAssetId: id }, select: { id: true, title: true } }), db.podcastEpisodeRevision.findMany({ where: { audioAssetId: id }, select: { id: true, episodeId: true, revisionNumber: true } }),
    db.release.findMany({ where: { artworkAssetId: id }, select: { id: true, title: true } }), db.releaseRevision.findMany({ where: { artworkAssetId: id }, select: { id: true, releaseId: true, revisionNumber: true } }),
  ]);
  return [
    ...artists.map((row) => ({ type: "ARTIST_WORKING", ...row })), ...artistRevisions.map((row) => ({ type: "ARTIST_REVISION", ...row })),
    ...tracks.map((row) => ({ type: "TRACK_WORKING", ...row })), ...trackRevisions.map((row) => ({ type: "TRACK_REVISION", ...row })),
    ...trackAudio.map((row) => ({ type: "TRACK_AUDIO_WORKING", ...row })), ...trackRevisionAudio.map((row) => ({ type: "TRACK_AUDIO_REVISION", ...row })),
    ...podcasts.map((row) => ({ type: "PODCAST_WORKING", ...row })), ...podcastRevisions.map((row) => ({ type: "PODCAST_REVISION", ...row })),
    ...podcastAudio.map((row) => ({ type: "PODCAST_AUDIO_WORKING", ...row })), ...podcastRevisionAudio.map((row) => ({ type: "PODCAST_AUDIO_REVISION", ...row })),
    ...releases.map((row) => ({ type: "RELEASE_WORKING", ...row })), ...releaseRevisions.map((row) => ({ type: "RELEASE_REVISION", ...row })),
  ];
}

export async function getMediaReferences(actor: Actor, id: string) { requirePermission(actor, "media:read"); return referenceRows(prisma, id); }

export async function reconcileMediaReference(db: Db, id: string | null | undefined, now = new Date()) {
  if (!id) return;
  const count = (await referenceRows(db, id)).length;
  await db.mediaAsset.updateMany({ where: { id }, data: { unreferencedAt: count ? null : now } });
}

export async function auditMediaAttachment(db: Db, actor: Actor, previousId: string | null, nextId: string | null, metadata: Prisma.InputJsonValue, expectedKind: MediaKind = "IMAGE") {
  if (previousId === nextId) return;
  if (nextId) {
    const asset = await db.mediaAsset.findUnique({ where: { id: nextId } });
    if (!asset || asset.status !== MediaStatus.READY || asset.kind !== expectedKind) throw new AppError(expectedKind === "AUDIO" ? "Selected audio must be a READY MP3 audio asset." : "Selected artwork must be a READY image.", 422, expectedKind === "AUDIO" ? "AUDIO_NOT_READY" : "ARTWORK_NOT_READY");
  }
  const action: AuditAction = previousId && nextId ? "MEDIA_REPLACE" : nextId ? "MEDIA_ATTACH" : "MEDIA_DETACH";
  await db.mediaAuditLog.create({ data: { mediaAssetId: nextId ?? previousId, actorId: actor.userId, action, metadata } });
  await reconcileMediaReference(db, previousId); await reconcileMediaReference(db, nextId);
}

export async function assertReadyArtwork(db: Db, id: string | null, required: boolean) {
  if (!id) { if (required) throw new AppError("Artwork is required before publishing or scheduling.", 422, "ARTWORK_REQUIRED"); return null; }
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.kind !== "IMAGE" || asset.status !== MediaStatus.READY) throw new AppError("Selected artwork must be a READY image.", 422, "ARTWORK_NOT_READY");
  return asset;
}

export async function assertReadyAudio(db: Db, id: string | null, required: boolean) {
  if (!id) { if (required) throw new AppError("Audio is required before publishing or scheduling.", 422, "AUDIO_REQUIRED"); return null; }
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.kind !== "AUDIO" || asset.status !== MediaStatus.READY) throw new AppError("Selected audio must be a READY MP3 audio asset.", 422, "AUDIO_NOT_READY"); return asset;
}

export async function retireMedia(actor: Actor, id: string) {
  requirePermission(actor, "media:retire");
  return prisma.$transaction(async (tx) => {
    const current = await tx.mediaAsset.findUnique({ where: { id } });
    if (current?.status === "PROCESSING") throw new AppError("Processing media cannot be retired.", 409, "MEDIA_PROCESSING");
    const references = await referenceRows(tx, id); if (references.length) throw new AppError("Referenced media cannot be retired.", 409, "MEDIA_REFERENCED", { references });
    const asset = await tx.mediaAsset.update({ where: { id }, data: { status: "RETIRED", retiredAt: new Date() } });
    await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_RETIRE" } }); return asset;
  });
}

export async function permanentlyDeleteMedia(actor: Actor, id: string, storage: StorageProvider = mediaStorage) {
  requirePermission(actor, "media:hard-delete");
  const asset = await prisma.mediaAsset.findUnique({ where: { id }, include: { variants: true, processingJob: true } });
  if (!asset) return { id, deleted: false, alreadyDeleted: true, deletedObjectCount: 0 };
  if (asset.status !== "RETIRED") throw new AppError("Only retired media can be permanently deleted.", 409, "MEDIA_DELETE_NOT_RETIRED");
  const references = await referenceRows(prisma, id);
  if (references.length) throw new AppError("Referenced media cannot be permanently deleted.", 409, "MEDIA_REFERENCED", { references });
  if (asset.processingJob?.status === "RUNNING") throw new AppError("Media with a running processing job cannot be permanently deleted.", 409, "MEDIA_JOB_RUNNING");
  const storageKeys = [...new Set([asset.sourceStorageKey, ...asset.variants.map(({ storageKey }) => storageKey)].filter((value): value is string => Boolean(value)))];
  if (storageKeys.length && asset.provider !== storage.kind) throw new AppError("The asset storage provider is not available for deletion.", 409, "MEDIA_STORAGE_PROVIDER_MISMATCH");
  const storageResults = await Promise.allSettled(storageKeys.map((key) => storage.delete(key)));
  const storageFailure = storageResults.find((result) => result.status === "rejected");
  if (storageFailure?.status === "rejected") {
    logSafeError("media_permanent_delete_storage_failed", storageFailure.reason, { operation: "permanent media deletion", mediaAssetId: id, storageProvider: storage.kind, objectCount: storageKeys.length });
    throw new AppError("Media storage deletion failed cleanly. The database record was preserved for retry.", 502, "MEDIA_DELETE_STORAGE_FAILED");
  }
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "media_assets" WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) return { id, deleted: false, alreadyDeleted: true, deletedObjectCount: storageKeys.length };
    const current = await tx.mediaAsset.findUniqueOrThrow({ where: { id }, include: { variants: true, processingJob: true } });
    if (current.status !== "RETIRED") throw new AppError("Only retired media can be permanently deleted.", 409, "MEDIA_DELETE_NOT_RETIRED");
    const blockingReferences = await referenceRows(tx, id);
    if (blockingReferences.length) throw new AppError("Referenced media cannot be permanently deleted.", 409, "MEDIA_REFERENCED", { references: blockingReferences });
    if (current.processingJob?.status === "RUNNING") throw new AppError("Media with a running processing job cannot be permanently deleted.", 409, "MEDIA_JOB_RUNNING");
    await tx.mediaAuditLog.create({ data: {
      mediaAssetId: id, actorId: actor.userId, action: "MEDIA_DELETE",
      metadata: { mediaAssetId: id, kind: current.kind, formerStatus: current.status, sha256Checksum: current.sha256Checksum, deletedVariantCount: current.variants.length, deletedObjectCount: storageKeys.length },
    } });
    await tx.mediaProcessingJob.deleteMany({ where: { mediaAssetId: id } });
    await tx.mediaVariant.deleteMany({ where: { mediaAssetId: id } });
    await tx.mediaAsset.delete({ where: { id } });
    return { id, deleted: true, alreadyDeleted: false, deletedObjectCount: storageKeys.length };
  });
}

export async function purgeEligibleMedia(actor: Actor, now = new Date(), storage: StorageProvider = mediaStorage) {
  requirePermission(actor, "media:purge"); const cutoff = new Date(now.getTime() - RETENTION_MS);
  const candidates = await prisma.mediaAsset.findMany({ where: { unreferencedAt: { lte: cutoff } }, include: { variants: true } }); let purged = 0;
  for (const candidate of candidates) {
    if ((await referenceRows(prisma, candidate.id)).length) { await reconcileMediaReference(prisma, candidate.id, now); continue; }
    await Promise.all([...(candidate.sourceStorageKey ? [storage.delete(candidate.sourceStorageKey)] : []), ...candidate.variants.map((variant) => storage.delete(variant.storageKey))]);
    await prisma.$transaction(async (tx) => { await tx.mediaAuditLog.create({ data: { mediaAssetId: candidate.id, actorId: actor.userId, action: "MEDIA_PURGE", metadata: { mediaAssetId: candidate.id, compatibilityFilename: candidate.compatibilityFilename } } }); await tx.mediaAsset.update({ where: { id: candidate.id }, data: { status: "RETIRED", retiredAt: now } }); await tx.mediaProcessingJob.deleteMany({ where: { mediaAssetId: candidate.id } }); await tx.mediaVariant.deleteMany({ where: { mediaAssetId: candidate.id } }); await tx.mediaAsset.delete({ where: { id: candidate.id } }); }); purged += 1;
  }
  return { examined: candidates.length, purged };
}

export async function resolveLegacyMedia(filename: string, variantKey: string) {
  if (!/^[0-9a-f-]+\.(jpg|png)$/i.test(filename)) return null;
  return prisma.mediaVariant.findFirst({ where: { variantKey: variantKey as never, mediaAsset: { compatibilityFilename: filename, status: "READY" } }, include: { mediaAsset: true } });
}

export async function resolveLegacyAudio(legacyAudioId: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(legacyAudioId)) return null;
  return prisma.mediaAsset.findFirst({ where: { legacyAudioId, kind: "AUDIO", status: "READY" } });
}
