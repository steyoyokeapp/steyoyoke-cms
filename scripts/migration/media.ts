import path from "node:path";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { checksum, inspectImage } from "../../src/modules/media/image";
import { runMediaProcessingJobs } from "../../src/modules/media/image-worker";
import type { StorageProvider } from "../../src/modules/media/storage";
import { stableUuid } from "./identity";
import { checkpoint, conflict } from "./ownership";
import { externalAudioInvariantError, matchesExpectedRecord } from "./safety";

export function historicalImageSourceIdentity(mediaRoot: string, sourcePath: string, sha256Checksum: string) {
  const relative = path.relative(path.resolve(mediaRoot), path.resolve(sourcePath)).split(path.sep).join("/").normalize("NFC");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Historical image is outside the approved media snapshot.");
  return `${relative}:${sha256Checksum.toLowerCase()}`;
}

export function historicalImageId(sourceIdentity: string) { return stableUuid("historical-image-v2", sourceIdentity); }

async function putOwnedSource(storage: StorageProvider, key: string, bytes: Buffer, expectedChecksum: string) {
  if (await storage.exists(key)) {
    if (checksum(await storage.read(key)) !== expectedChecksum) throw new Error(`Owned storage key ${key} exists with conflicting content.`);
    return "existing" as const;
  }
  try { await storage.put(key, bytes); }
  catch (error) {
    try { if (checksum(await storage.read(key)) === expectedChecksum) return "existing" as const; } catch { /* retain original error */ }
    throw error;
  }
  return "created" as const;
}

export class MigrationMediaImporter {
  private readonly images = new Map<string, string>();
  private readonly audio = new Map<string, string>();

  constructor(
    private readonly db: PrismaClient,
    readonly storage: StorageProvider,
    private readonly actorId: string,
    private readonly runId: string,
    private readonly mediaRoot: string,
  ) {}

  async image(sourcePath: string) {
    const bytes = await readFile(sourcePath);
    const inspected = await inspectImage(bytes);
    const sourceIdentity = historicalImageSourceIdentity(this.mediaRoot, sourcePath, inspected.sourceChecksum);
    const cached = this.images.get(sourceIdentity); if (cached) return cached;
    const id = historicalImageId(sourceIdentity);
    const outputExtension = inspected.hasAlpha ? "png" : "jpg";
    const outputMimeType = inspected.hasAlpha ? "image/png" : "image/jpeg";
    const sourceExtension = inspected.sourceFormat === "jpeg" ? "jpg" : inspected.sourceFormat;
    const sourceStorageKey = `images/${id}/source.${sourceExtension}`;
    const compatibilityFilename = `${id}.${outputExtension}`;
    const expected = {
      id, kind: "IMAGE", provider: this.storage.kind, sourceStorageKey, compatibilityFilename,
      originalFilename: path.basename(sourcePath).normalize("NFC"), mimeType: outputMimeType, byteSize: bytes.length,
      sha256Checksum: inspected.sourceChecksum, width: inspected.sourceWidth, height: inspected.sourceHeight, createdById: this.actorId,
    } as const;

    const existing = await this.db.mediaAsset.findUnique({ where: { id } });
    await checkpoint(this.db, this.runId, "IMAGE", sourceIdentity, { canonicalId: id, stage: "ASSET", status: "PROCESSING", metadata: { createdByRun: !existing, sourceStorageKey, sourceRelativePath: sourceIdentity.slice(0, sourceIdentity.lastIndexOf(":")), sha256Checksum: inspected.sourceChecksum } });
    if (existing && !matchesExpectedRecord(existing, expected, [])) await conflict(this.db, this.runId, "IMAGE", sourceIdentity, `Historical image ${sourceIdentity} conflicts with MediaAsset ${id}.`, id);
    if (!existing) {
      const bySource = await this.db.mediaAsset.findUnique({ where: { sourceStorageKey } });
      if (bySource) await conflict(this.db, this.runId, "IMAGE", sourceIdentity, `Historical image storage key is owned by unrelated MediaAsset ${bySource.id}.`, bySource.id);
      await this.db.mediaAsset.create({ data: { ...expected, status: "PROCESSING" } });
    }

    try {
      const sourceWrite = await putOwnedSource(this.storage, sourceStorageKey, bytes, inspected.sourceChecksum);
      await checkpoint(this.db, this.runId, "IMAGE", sourceIdentity, { canonicalId: id, stage: "SOURCE_STORED", status: "PROCESSING", metadata: { sourceStorageKey, sha256Checksum: inspected.sourceChecksum, sourceCreatedByRun: sourceWrite === "created" } });
      const job = await this.db.mediaProcessingJob.findUnique({ where: { mediaAssetId: id } });
      const jobId = stableUuid("migration-image-job", sourceIdentity);
      if (job && job.id !== jobId) await conflict(this.db, this.runId, "IMAGE_JOB", sourceIdentity, `Historical image job for ${sourceIdentity} has unrelated identity ${job.id}.`, job.id);
      if (!job) await this.db.mediaProcessingJob.create({ data: { id: jobId, mediaAssetId: id } });
      else if (job.status === "FAILED") await this.db.mediaProcessingJob.update({ where: { id: job.id }, data: { status: "PENDING", attempts: 0, availableAt: new Date(), lockedAt: null, completedAt: null, lastError: null } });
      await checkpoint(this.db, this.runId, "IMAGE_JOB", sourceIdentity, { canonicalId: job?.id ?? jobId, stage: "JOB_PENDING", status: "PROCESSING", metadata: { createdByRun: !job, mediaAssetId: id } });
      const auditId = stableUuid("migration-media-upload-audit", `${this.runId}:${sourceIdentity}`);
      if (!await this.db.mediaAuditLog.findUnique({ where: { id: auditId } })) await this.db.mediaAuditLog.create({ data: { id: auditId, mediaAssetId: id, actorId: this.actorId, action: "MEDIA_UPLOAD", metadata: { migrationRunId: this.runId, historicalSourceIdentity: sourceIdentity, status: "PROCESSING" } } });
      await checkpoint(this.db, this.runId, "IMAGE", sourceIdentity, { canonicalId: id, stage: "JOB_PENDING", status: "PROCESSING", metadata: { sourceStorageKey, processingJobId: stableUuid("migration-image-job", sourceIdentity) } });
    } catch (error) {
      await checkpoint(this.db, this.runId, "IMAGE", sourceIdentity, { canonicalId: id, stage: "SOURCE_OR_JOB_FAILED", status: "FAILED", error: error instanceof Error ? error.message : "Historical image ingest failed." });
      throw error;
    }
    this.images.set(sourceIdentity, id);
    return id;
  }

  async processImages() {
    const records = await this.db.migrationRecord.findMany({ where: { runId: this.runId, entityType: "IMAGE" } });
    for (const record of records) {
      const before = record.canonicalId ? await this.db.mediaAsset.findUnique({ where: { id: record.canonicalId }, include: { variants: true } }) : null;
      const previousVariantIds = new Set(before?.variants.map(({ id }) => id) ?? []);
      if (record.canonicalId) {
        for (;;) {
          const result = await runMediaProcessingJobs({ limit: 1, mediaAssetId: record.canonicalId, storage: this.storage, db: this.db, auditMetadata: { migrationRunId: this.runId } });
          if (result.examined === 0) break;
          if (result.failed) throw new Error(`${result.failed} historical image processing job(s) failed.`);
        }
      }
      const asset = record.canonicalId ? await this.db.mediaAsset.findUnique({ where: { id: record.canonicalId }, include: { variants: true, processingJob: true } }) : null;
      if (!asset || asset.status !== "READY" || asset.processingJob?.status !== "COMPLETED" || asset.variants.length !== 6) {
        await checkpoint(this.db, this.runId, "IMAGE", record.sourceIdentity, { canonicalId: record.canonicalId, stage: "READY_VERIFICATION_FAILED", status: "FAILED", error: "Historical image did not reach READY with one completed job and six variants." });
        throw new Error(`Historical image ${record.sourceIdentity} did not reach READY.`);
      }
      await checkpoint(this.db, this.runId, "IMAGE", record.sourceIdentity, { canonicalId: asset.id, stage: "READY", status: "COMPLETED", metadata: { sourceStorageKey: asset.sourceStorageKey, variantStorageKeys: asset.variants.map((variant) => variant.storageKey), processingJobId: asset.processingJob.id } });
      await checkpoint(this.db, this.runId, "IMAGE_JOB", record.sourceIdentity, { canonicalId: asset.processingJob.id, stage: "COMPLETED", status: "COMPLETED" });
      const processAudit = await this.db.mediaAuditLog.findFirst({ where: { mediaAssetId: asset.id, action: "MEDIA_PROCESS" }, orderBy: { createdAt: "desc" } });
      const auditMetadata = processAudit?.metadata && typeof processAudit.metadata === "object" && !Array.isArray(processAudit.metadata) ? processAudit.metadata : {};
      const createdStorageKeys = new Set(auditMetadata.migrationRunId === this.runId && Array.isArray(auditMetadata.createdStorageKeys) ? auditMetadata.createdStorageKeys.filter((key): key is string => typeof key === "string") : []);
      for (const variant of asset.variants) await checkpoint(this.db, this.runId, "IMAGE_VARIANT", `${record.sourceIdentity}:${variant.variantKey}`, { canonicalId: variant.id, stage: "READY", status: "COMPLETED", metadata: { createdByRun: !previousVariantIds.has(variant.id), storageKey: variant.storageKey, storageCreatedByRun: createdStorageKeys.has(variant.storageKey) } });
    }
  }

  async externalAudio(legacyAudioId: string) {
    const key = legacyAudioId.trim(); const cached = this.audio.get(key); if (cached) return cached;
    const id = stableUuid("legacy-audio", key);
    const expected = { id, kind: "AUDIO", status: "EXTERNAL", provider: "LEGACY_EXTERNAL", legacyAudioId: key, createdById: this.actorId } as const;
    const existing = await this.db.mediaAsset.findUnique({ where: { id }, include: { variants: true, processingJob: true } });
    const invariantError = existing ? externalAudioInvariantError(existing, key) : null;
    if (invariantError) await conflict(this.db, this.runId, "AUDIO", key, `Historical audio ${key} conflicts: ${invariantError}.`, id);
    if (!existing) {
      const byIdentity = await this.db.mediaAsset.findUnique({ where: { legacyAudioId: key } });
      if (byIdentity) await conflict(this.db, this.runId, "AUDIO", key, `Historical audio identity ${key} is owned by unrelated MediaAsset ${byIdentity.id}.`, byIdentity.id);
      await this.db.mediaAsset.create({ data: { ...expected, sourceStorageKey: null, compatibilityFilename: null, originalFilename: null, mimeType: null, byteSize: null, sha256Checksum: null, width: null, height: null, durationMs: null } });
    }
    await checkpoint(this.db, this.runId, "AUDIO", key, { canonicalId: id, stage: "EXTERNAL_VERIFIED", status: "COMPLETED", metadata: { createdByRun: !existing, legacyAudioId: key, copiedBinary: false } });
    this.audio.set(key, id); return id;
  }

  get imageCount() { return this.images.size; }
  get audioCount() { return this.audio.size; }
}

export { MigrationMediaImporter as RehearsalMediaImporter };
