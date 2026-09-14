import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { log, logSafeError, safeErrorFields } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { mapWithConcurrency } from "@/modules/media/concurrency";
import { checksum, IMAGE_VARIANTS, processImage } from "@/modules/media/image";
import { mediaStorage, type StorageProvider } from "@/modules/media/storage";

export const MEDIA_JOB_MAX_ATTEMPTS = 3;
export const MEDIA_JOB_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
export const MEDIA_STORAGE_WRITE_CONCURRENCY = 3;

const milliseconds = (value: number) => Math.round(value * 100) / 100;
type ClaimedJob = Prisma.MediaProcessingJobGetPayload<{ include: { mediaAsset: true } }>;
type WorkerDb = PrismaClient | typeof prisma;

export async function putImmutableWithProvenance(storage: StorageProvider, key: string, bytes: Buffer, expectedChecksum: string, ownershipToken?: string) {
  try {
    await storage.put(key, bytes, { ownershipToken });
    return { state: "created" as const, ownedByToken: Boolean(ownershipToken) };
  }
  catch (error) {
    try {
      if (checksum(await storage.read(key)) === expectedChecksum) {
        const storedOwnershipToken = ownershipToken ? await storage.getOwnershipToken(key) : null;
        return { state: "existing" as const, ownedByToken: Boolean(ownershipToken && storedOwnershipToken === ownershipToken.toLowerCase()) };
      }
    }
    catch { /* Preserve the original immutable-write failure. */ }
    throw error;
  }
}

async function claimJob(db: WorkerDb, id: string, now: Date) {
  const staleBefore = new Date(now.getTime() - MEDIA_JOB_LOCK_TIMEOUT_MS);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "media_processing_jobs"
      WHERE id = ${id}::uuid
        AND attempts < ${MEDIA_JOB_MAX_ATTEMPTS}
        AND EXISTS (
          SELECT 1 FROM "media_assets"
          WHERE "media_assets".id = "media_processing_jobs"."mediaAssetId"
            AND "media_assets".status = 'PROCESSING' AND "media_assets".kind = 'IMAGE'
        )
        AND ((status = 'PENDING' AND "availableAt" <= ${now}) OR (status = 'RUNNING' AND "lockedAt" <= ${staleBefore}))
      FOR UPDATE SKIP LOCKED
    `;
    if (!rows.length) return null;
    return tx.mediaProcessingJob.update({
      where: { id },
      data: { status: "RUNNING", attempts: { increment: 1 }, lockedAt: now, completedAt: null },
      include: { mediaAsset: true },
    });
  });
}

async function recordFailure(db: WorkerDb, job: ClaimedJob, error: unknown) {
  const finalAttempt = job.attempts >= MEDIA_JOB_MAX_ATTEMPTS;
  const retryAt = new Date(Date.now() + 30_000 * 2 ** Math.max(0, job.attempts - 1));
  const message = safeErrorFields(error).errorMessage;
  return db.$transaction(async (tx) => {
    const updated = await tx.mediaProcessingJob.updateMany({
      where: { id: job.id, status: "RUNNING", attempts: job.attempts, lockedAt: job.lockedAt },
      data: finalAttempt
        ? { status: "FAILED", lockedAt: null, completedAt: new Date(), lastError: message }
        : { status: "PENDING", lockedAt: null, availableAt: retryAt, lastError: message },
    });
    if (!updated.count) return "lease_lost" as const;
    if (finalAttempt) await tx.mediaAsset.updateMany({ where: { id: job.mediaAssetId, status: "PROCESSING" }, data: { status: "FAILED", failureReason: "Image representation processing failed." } });
    return finalAttempt ? "failed" as const : "retry_pending" as const;
  });
}

async function processJob(db: WorkerDb, job: ClaimedJob, storage: StorageProvider, auditMetadata?: Prisma.InputJsonObject, storageOwnershipToken?: string) {
  const workerStartedAtMs = performance.now();
  try {
    const asset = job.mediaAsset;
    if (asset.kind !== "IMAGE" || asset.status !== "PROCESSING" || !asset.sourceStorageKey || asset.provider !== storage.kind) throw new Error("Image processing job has incompatible source metadata or lifecycle state.");
    const sourceReadStartedAtMs = performance.now();
    const bytes = await storage.read(asset.sourceStorageKey);
    const sourceReadMs = performance.now() - sourceReadStartedAtMs;
    if (asset.sha256Checksum && checksum(bytes) !== asset.sha256Checksum) throw new Error("Stored image source checksum does not match its immutable metadata.");
    const processed = await processImage(bytes);
    const variantWrites = await mapWithConcurrency(processed.variants, MEDIA_STORAGE_WRITE_CONCURRENCY, async (variant) => {
      const storageKey = `images/${asset.id}/${variant.variantKey.toLowerCase().replaceAll("_", "-")}.${variant.extension}`;
      const startedAtMs = performance.now();
      const storageWrite = await putImmutableWithProvenance(storage, storageKey, variant.bytes, variant.sha256Checksum, storageOwnershipToken);
      return { variant, storageKey, storageWrite, writeMs: performance.now() - startedAtMs };
    });
    const variantData: Prisma.MediaVariantCreateManyInput[] = variantWrites.map(({ variant, storageKey }) => ({
      id: crypto.randomUUID(), mediaAssetId: asset.id, variantKey: variant.variantKey, storageKey, mimeType: variant.mimeType,
      byteSize: variant.bytes.length, sha256Checksum: variant.sha256Checksum, width: variant.width, height: variant.height,
    }));
    let dbVariantWriteMs = 0;
    const finalizeStartedAtMs = performance.now();
    await db.$transaction(async (tx) => {
      const ownsLease = await tx.mediaProcessingJob.count({ where: { id: job.id, status: "RUNNING", attempts: job.attempts, lockedAt: job.lockedAt } });
      if (!ownsLease) throw new Error("Image processing job lease was lost.");
      const dbVariantWriteStartedAtMs = performance.now();
      await tx.mediaVariant.createMany({ data: variantData, skipDuplicates: true });
      dbVariantWriteMs = performance.now() - dbVariantWriteStartedAtMs;
      const stored = await tx.mediaVariant.findMany({ where: { mediaAssetId: asset.id } });
      const complete = stored.length === IMAGE_VARIANTS.length && variantData.every((expected) => stored.some((value) =>
        value.variantKey === expected.variantKey && value.storageKey === expected.storageKey && value.mimeType === expected.mimeType
        && value.byteSize === expected.byteSize && value.sha256Checksum === expected.sha256Checksum && value.width === expected.width && value.height === expected.height));
      if (!complete) throw new Error("Image processing did not persist every required immutable representation.");
      const finalized = await tx.mediaAsset.updateMany({ where: { id: asset.id, status: "PROCESSING" }, data: { status: "READY", failureReason: null, unreferencedAt: new Date() } });
      if (!finalized.count) throw new Error("Image asset lifecycle changed before worker finalization.");
      await tx.mediaProcessingJob.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, completedAt: new Date(), lastError: null } });
      await tx.mediaAuditLog.create({ data: { mediaAssetId: asset.id, actorId: asset.createdById, action: "MEDIA_PROCESS", metadata: {
        ...auditMetadata,
        variantCount: stored.length,
        attempt: job.attempts,
        createdStorageKeys: variantWrites.filter(({ storageWrite }) => storageWrite.state === "created").map(({ storageKey }) => storageKey),
        ...(storageOwnershipToken ? { ownedStorageKeys: variantWrites.filter(({ storageWrite }) => storageWrite.ownedByToken).map(({ storageKey }) => storageKey) } : {}),
      } } });
    });
    const finalizeMs = performance.now() - finalizeStartedAtMs;
    const storageWriteMs = variantWrites.reduce((sum, value) => sum + value.writeMs, 0);
    log("info", "media_image_processing_profile", {
      operation: "image representation processing", mediaAssetId: asset.id, processingJobId: job.id, attempt: job.attempts,
      storageProvider: storage.kind, queueDelayMs: milliseconds(Math.max(0, job.lockedAt!.getTime() - job.availableAt.getTime())),
      totalMs: milliseconds(performance.now() - workerStartedAtMs), sourceReadMs: milliseconds(sourceReadMs),
      imageProcessingMs: milliseconds(processed.profile.imageProcessingMs), metadataMs: milliseconds(processed.profile.metadataMs),
      variantProcessingMs: milliseconds(processed.profile.variantProcessingMs), storageWriteMs: milliseconds(storageWriteMs),
      s3WriteMs: storage.kind === "S3_COMPATIBLE" ? milliseconds(storageWriteMs) : undefined,
      dbVariantWriteMs: milliseconds(dbVariantWriteMs), finalizeMs: milliseconds(finalizeMs), variantCount: processed.variants.length,
      inputByteSize: bytes.length, inputWidth: processed.sourceWidth, inputHeight: processed.sourceHeight,
      ...Object.fromEntries(processed.profile.variants.map((timing) => [`variantProcessingMs_${timing.variantKey}`, milliseconds(timing.processingMs)])),
      ...Object.fromEntries(variantWrites.map(({ variant, writeMs }) => [`variantStorageWriteMs_${variant.variantKey}`, milliseconds(writeMs)])),
    });
    return "completed" as const;
  } catch (error) {
    const outcome = await recordFailure(db, job, error);
    logSafeError("media_image_processing_failed", error, {
      operation: "image representation processing", mediaAssetId: job.mediaAssetId, processingJobId: job.id,
      attempt: job.attempts, outcome, storageProvider: storage.kind,
    });
    return outcome;
  }
}

export async function runMediaProcessingJobs(options: { limit?: number; mediaAssetId?: string; storage?: StorageProvider; now?: Date; db?: WorkerDb; auditMetadata?: Prisma.InputJsonObject; storageOwnershipToken?: string } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 25));
  const storage = options.storage ?? mediaStorage;
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - MEDIA_JOB_LOCK_TIMEOUT_MS);
  const candidates = await db.mediaProcessingJob.findMany({
    where: {
      attempts: { lt: MEDIA_JOB_MAX_ATTEMPTS }, mediaAsset: { status: "PROCESSING", kind: "IMAGE" }, ...(options.mediaAssetId ? { mediaAssetId: options.mediaAssetId } : {}),
      OR: [{ status: "PENDING", availableAt: { lte: now } }, { status: "RUNNING", lockedAt: { lte: staleBefore } }],
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }], take: limit, select: { id: true },
  });
  const outcomes: string[] = [];
  for (const candidate of candidates) {
    const claimed = await claimJob(db, candidate.id, now);
    if (claimed) outcomes.push(await processJob(db, claimed, storage, options.auditMetadata, options.storageOwnershipToken));
  }
  return {
    examined: candidates.length,
    completed: outcomes.filter((value) => value === "completed").length,
    retryPending: outcomes.filter((value) => value === "retry_pending").length,
    failed: outcomes.filter((value) => value === "failed").length,
    leaseLost: outcomes.filter((value) => value === "lease_lost").length,
  };
}
