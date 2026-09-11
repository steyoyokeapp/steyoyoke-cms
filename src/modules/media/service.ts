import crypto from "node:crypto";
import type { AuditAction, MediaKind, Prisma } from "@/generated/prisma/client";
import { MediaStatus } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authorization";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { logSafeError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { processImage } from "@/modules/media/image";
import { processAudio } from "@/modules/media/audio";
import { mediaStorage, type StorageProvider } from "@/modules/media/storage";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type Db = Prisma.TransactionClient | typeof prisma;

type UploadDiagnostics = { requestId?: string };

export async function createAndProcessImage(actor: Actor, file: { name: string; bytes: Buffer }, storage: StorageProvider = mediaStorage, diagnostics: UploadDiagnostics = {}) {
  requirePermission(actor, "media:upload");
  const id = crypto.randomUUID();
  let failureKind = "processing";
  let failureStage = "process_image";
  try {
    const processed = await processImage(file.bytes);
    const original = processed.variants[0]!;
    const sourceExtension = processed.sourceFormat === "jpeg" ? "jpg" : processed.sourceFormat;
    const sourceStorageKey = `images/${id}/source.${sourceExtension}`;
    const compatibilityFilename = `${id}.${original.extension}`;
    failureKind = "database"; failureStage = "create_media_asset";
    const asset = await prisma.mediaAsset.create({ data: {
      id, kind: "IMAGE", status: "PROCESSING", provider: storage.kind, sourceStorageKey, compatibilityFilename,
      originalFilename: file.name.slice(0, 255) || "upload", mimeType: original.mimeType, byteSize: file.bytes.length,
      sha256Checksum: processed.sourceChecksum, width: processed.sourceWidth, height: processed.sourceHeight, createdById: actor.userId,
    } });
    const written: string[] = [];
    try {
      failureKind = "storage"; failureStage = "write_source";
      await storage.put(sourceStorageKey, file.bytes); written.push(sourceStorageKey);
      const variantData: Prisma.MediaVariantCreateManyInput[] = [];
      for (const variant of processed.variants) {
        const storageKey = `images/${id}/${variant.variantKey.toLowerCase().replaceAll("_", "-")}.${variant.extension}`;
        failureStage = "write_variant";
        await storage.put(storageKey, variant.bytes); written.push(storageKey);
        variantData.push({ id: crypto.randomUUID(), mediaAssetId: id, variantKey: variant.variantKey, storageKey, mimeType: variant.mimeType, byteSize: variant.bytes.length, sha256Checksum: variant.sha256Checksum, width: variant.width, height: variant.height });
      }
      failureKind = "database"; failureStage = "finalize_media_asset";
      return await prisma.$transaction(async (tx) => {
        await tx.mediaVariant.createMany({ data: variantData });
        const ready = await tx.mediaAsset.update({ where: { id }, data: { status: "READY", unreferencedAt: new Date() }, include: { variants: { orderBy: { variantKey: "asc" } }, createdBy: { select: { id: true, name: true } } } });
        await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_UPLOAD", metadata: { kind: "IMAGE", originalFilename: ready.originalFilename, byteSize: ready.byteSize } } });
        return ready;
      });
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...written.map((key) => storage.delete(key)),
        prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED", failureReason: "Image processing or local storage failed." } }),
      ]);
      const cleanupFailure = cleanup.find((result) => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") logSafeError("media_image_upload_cleanup_failed", cleanupFailure.reason, { requestId: diagnostics.requestId, operation: "image upload", mediaAssetId: id, storageProvider: storage.kind });
      throw error;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
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
  const asset = await prisma.mediaAsset.findUnique({ where: { id }, include: { variants: { orderBy: { variantKey: "asc" } }, createdBy: { select: { id: true, name: true } } } });
  if (!asset) throw new AppError("Media asset not found.", 404, "MEDIA_NOT_FOUND");
  return { ...asset, references: await getMediaReferences(actor, id) };
}

export async function listMediaAssets(actor: Actor, kind?: MediaKind) {
  requirePermission(actor, "media:read");
  const assets = await prisma.mediaAsset.findMany({ where: kind ? { kind } : undefined, include: { variants: true, createdBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } });
  return Promise.all(assets.map(async (asset) => {
    const references = await referenceRows(prisma, asset.id);
    return { ...asset, references, referenceCount: references.length };
  }));
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
    const references = await referenceRows(tx, id); if (references.length) throw new AppError("Referenced media cannot be retired.", 409, "MEDIA_REFERENCED", { references });
    const asset = await tx.mediaAsset.update({ where: { id }, data: { status: "RETIRED", retiredAt: new Date() } });
    await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_RETIRE" } }); return asset;
  });
}

export async function purgeEligibleMedia(actor: Actor, now = new Date(), storage: StorageProvider = mediaStorage) {
  requirePermission(actor, "media:purge"); const cutoff = new Date(now.getTime() - RETENTION_MS);
  const candidates = await prisma.mediaAsset.findMany({ where: { unreferencedAt: { lte: cutoff } }, include: { variants: true } }); let purged = 0;
  for (const candidate of candidates) {
    if ((await referenceRows(prisma, candidate.id)).length) { await reconcileMediaReference(prisma, candidate.id, now); continue; }
    await Promise.all([...(candidate.sourceStorageKey ? [storage.delete(candidate.sourceStorageKey)] : []), ...candidate.variants.map((variant) => storage.delete(variant.storageKey))]);
    await prisma.$transaction(async (tx) => { await tx.mediaAuditLog.create({ data: { mediaAssetId: candidate.id, actorId: actor.userId, action: "MEDIA_PURGE", metadata: { mediaAssetId: candidate.id, compatibilityFilename: candidate.compatibilityFilename } } }); await tx.mediaAsset.update({ where: { id: candidate.id }, data: { status: "RETIRED", retiredAt: now } }); await tx.mediaVariant.deleteMany({ where: { mediaAssetId: candidate.id } }); await tx.mediaAsset.delete({ where: { id: candidate.id } }); }); purged += 1;
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
