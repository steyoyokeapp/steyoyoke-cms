import crypto from "node:crypto";
import type { AuditAction, Prisma } from "@/generated/prisma/client";
import { MediaStatus } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authorization";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { processImage } from "@/modules/media/image";
import { localStorage, type StorageProvider } from "@/modules/media/storage";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type Db = Prisma.TransactionClient | typeof prisma;

export async function createAndProcessImage(actor: Actor, file: { name: string; bytes: Buffer }, storage: StorageProvider = localStorage) {
  requirePermission(actor, "media:upload");
  const id = crypto.randomUUID();
  try {
    const processed = await processImage(file.bytes);
    const original = processed.variants[0]!;
    const sourceExtension = processed.sourceFormat === "jpeg" ? "jpg" : processed.sourceFormat;
    const sourceStorageKey = `images/${id}/source.${sourceExtension}`;
    const compatibilityFilename = `${id}.${original.extension}`;
    const asset = await prisma.mediaAsset.create({ data: {
      id, kind: "IMAGE", status: "PROCESSING", provider: "LOCAL", sourceStorageKey, compatibilityFilename,
      originalFilename: file.name.slice(0, 255) || "upload", mimeType: original.mimeType, byteSize: file.bytes.length,
      sha256Checksum: processed.sourceChecksum, width: processed.sourceWidth, height: processed.sourceHeight, createdById: actor.userId,
    } });
    const written: string[] = [];
    try {
      await storage.put(sourceStorageKey, file.bytes); written.push(sourceStorageKey);
      const variantData: Prisma.MediaVariantCreateManyInput[] = [];
      for (const variant of processed.variants) {
        const storageKey = `images/${id}/${variant.variantKey.toLowerCase().replaceAll("_", "-")}.${variant.extension}`;
        await storage.put(storageKey, variant.bytes); written.push(storageKey);
        variantData.push({ id: crypto.randomUUID(), mediaAssetId: id, variantKey: variant.variantKey, storageKey, mimeType: variant.mimeType, byteSize: variant.bytes.length, sha256Checksum: variant.sha256Checksum, width: variant.width, height: variant.height });
      }
      return await prisma.$transaction(async (tx) => {
        await tx.mediaVariant.createMany({ data: variantData });
        const ready = await tx.mediaAsset.update({ where: { id }, data: { status: "READY", unreferencedAt: new Date() }, include: { variants: { orderBy: { variantKey: "asc" } }, createdBy: { select: { id: true, name: true } } } });
        await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_UPLOAD", metadata: { originalFilename: ready.originalFilename, byteSize: ready.byteSize } } });
        return ready;
      });
    } catch (error) {
      await Promise.all(written.map((key) => storage.delete(key)));
      await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED", failureReason: "Image processing or local storage failed." } });
      throw error;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Image upload failed cleanly.", 422, "IMAGE_UPLOAD_FAILED");
  }
}

export async function getMediaAsset(actor: Actor, id: string) {
  requirePermission(actor, "media:read");
  const asset = await prisma.mediaAsset.findUnique({ where: { id }, include: { variants: { orderBy: { variantKey: "asc" } }, createdBy: { select: { id: true, name: true } } } });
  if (!asset) throw new AppError("Media asset not found.", 404, "MEDIA_NOT_FOUND");
  return { ...asset, references: await getMediaReferences(actor, id) };
}

export async function listMediaAssets(actor: Actor) {
  requirePermission(actor, "media:read");
  const assets = await prisma.mediaAsset.findMany({ include: { variants: true, createdBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } });
  return Promise.all(assets.map(async (asset) => {
    const references = await referenceRows(prisma, asset.id);
    return { ...asset, references, referenceCount: references.length };
  }));
}

async function referenceRows(db: Db, id: string) {
  const [artists, artistRevisions, tracks, trackRevisions, podcasts, podcastRevisions, releases, releaseRevisions] = await Promise.all([
    db.artist.findMany({ where: { imageAssetId: id }, select: { id: true, name: true } }), db.artistRevision.findMany({ where: { imageAssetId: id }, select: { id: true, artistId: true, revisionNumber: true } }),
    db.track.findMany({ where: { artworkAssetId: id }, select: { id: true, title: true } }), db.trackRevision.findMany({ where: { artworkAssetId: id }, select: { id: true, trackId: true, revisionNumber: true } }),
    db.podcastEpisode.findMany({ where: { artworkAssetId: id }, select: { id: true, title: true } }), db.podcastEpisodeRevision.findMany({ where: { artworkAssetId: id }, select: { id: true, episodeId: true, revisionNumber: true } }),
    db.release.findMany({ where: { artworkAssetId: id }, select: { id: true, title: true } }), db.releaseRevision.findMany({ where: { artworkAssetId: id }, select: { id: true, releaseId: true, revisionNumber: true } }),
  ]);
  return [
    ...artists.map((row) => ({ type: "ARTIST_WORKING", ...row })), ...artistRevisions.map((row) => ({ type: "ARTIST_REVISION", ...row })),
    ...tracks.map((row) => ({ type: "TRACK_WORKING", ...row })), ...trackRevisions.map((row) => ({ type: "TRACK_REVISION", ...row })),
    ...podcasts.map((row) => ({ type: "PODCAST_WORKING", ...row })), ...podcastRevisions.map((row) => ({ type: "PODCAST_REVISION", ...row })),
    ...releases.map((row) => ({ type: "RELEASE_WORKING", ...row })), ...releaseRevisions.map((row) => ({ type: "RELEASE_REVISION", ...row })),
  ];
}

export async function getMediaReferences(actor: Actor, id: string) { requirePermission(actor, "media:read"); return referenceRows(prisma, id); }

export async function reconcileMediaReference(db: Db, id: string | null | undefined, now = new Date()) {
  if (!id) return;
  const count = (await referenceRows(db, id)).length;
  await db.mediaAsset.updateMany({ where: { id }, data: { unreferencedAt: count ? null : now } });
}

export async function auditMediaAttachment(db: Db, actor: Actor, previousId: string | null, nextId: string | null, metadata: Prisma.InputJsonValue) {
  if (previousId === nextId) return;
  if (nextId) {
    const asset = await db.mediaAsset.findUnique({ where: { id: nextId } });
    if (!asset || asset.status !== MediaStatus.READY) throw new AppError("Selected artwork must be a READY image.", 422, "ARTWORK_NOT_READY");
  }
  const action: AuditAction = previousId && nextId ? "MEDIA_REPLACE" : nextId ? "MEDIA_ATTACH" : "MEDIA_DETACH";
  await db.mediaAuditLog.create({ data: { mediaAssetId: nextId ?? previousId, actorId: actor.userId, action, metadata } });
  await reconcileMediaReference(db, previousId); await reconcileMediaReference(db, nextId);
}

export async function assertReadyArtwork(db: Db, id: string | null, required: boolean) {
  if (!id) { if (required) throw new AppError("Artwork is required before publishing or scheduling.", 422, "ARTWORK_REQUIRED"); return null; }
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.status !== MediaStatus.READY) throw new AppError("Selected artwork must be a READY image.", 422, "ARTWORK_NOT_READY");
  return asset;
}

export async function retireMedia(actor: Actor, id: string) {
  requirePermission(actor, "media:retire");
  return prisma.$transaction(async (tx) => {
    const references = await referenceRows(tx, id); if (references.length) throw new AppError("Referenced media cannot be retired.", 409, "MEDIA_REFERENCED", { references });
    const asset = await tx.mediaAsset.update({ where: { id }, data: { status: "RETIRED", retiredAt: new Date() } });
    await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_RETIRE" } }); return asset;
  });
}

export async function purgeEligibleMedia(actor: Actor, now = new Date(), storage: StorageProvider = localStorage) {
  requirePermission(actor, "media:purge"); const cutoff = new Date(now.getTime() - RETENTION_MS);
  const candidates = await prisma.mediaAsset.findMany({ where: { unreferencedAt: { lte: cutoff } }, include: { variants: true } }); let purged = 0;
  for (const candidate of candidates) {
    if ((await referenceRows(prisma, candidate.id)).length) { await reconcileMediaReference(prisma, candidate.id, now); continue; }
    await Promise.all([storage.delete(candidate.sourceStorageKey), ...candidate.variants.map((variant) => storage.delete(variant.storageKey))]);
    await prisma.$transaction(async (tx) => { await tx.mediaAuditLog.create({ data: { mediaAssetId: candidate.id, actorId: actor.userId, action: "MEDIA_PURGE", metadata: { mediaAssetId: candidate.id, compatibilityFilename: candidate.compatibilityFilename } } }); await tx.mediaAsset.update({ where: { id: candidate.id }, data: { status: "RETIRED", retiredAt: now } }); await tx.mediaVariant.deleteMany({ where: { mediaAssetId: candidate.id } }); await tx.mediaAsset.delete({ where: { id: candidate.id } }); }); purged += 1;
  }
  return { examined: candidates.length, purged };
}

export async function resolveLegacyMedia(filename: string, variantKey: string) {
  if (!/^[0-9a-f-]+\.(jpg|png)$/i.test(filename)) return null;
  return prisma.mediaVariant.findFirst({ where: { variantKey: variantKey as never, mediaAsset: { compatibilityFilename: filename, status: "READY" } }, include: { mediaAsset: true } });
}
