import path from "node:path";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { processImage } from "../../src/modules/media/image";
import { LocalStorageProvider } from "../../src/modules/media/storage";
import { stableUuid } from "./identity";

export class RehearsalMediaImporter {
  private readonly images = new Map<string, string>();
  private readonly audio = new Map<string, string>();
  readonly storage: LocalStorageProvider;

  constructor(private readonly db: PrismaClient, storageRoot: string, private readonly actorId: string) {
    this.storage = new LocalStorageProvider(storageRoot);
  }

  async image(sourcePath: string) {
    const cached = this.images.get(sourcePath); if (cached) return cached;
    const id = stableUuid("image", sourcePath); const bytes = await readFile(sourcePath); const processed = await processImage(bytes); const original = processed.variants[0]!;
    const sourceExtension = processed.sourceFormat === "jpeg" ? "jpg" : processed.sourceFormat;
    const sourceStorageKey = `images/${id}/source.${sourceExtension}`; const compatibilityFilename = `${id}.${original.extension}`;
    await this.storage.put(sourceStorageKey, bytes);
    const variants = [];
    for (const variant of processed.variants) {
      const storageKey = `images/${id}/${variant.variantKey.toLowerCase().replaceAll("_", "-")}.${variant.extension}`;
      await this.storage.put(storageKey, variant.bytes);
      variants.push({ id: stableUuid("image-variant", `${sourcePath}:${variant.variantKey}`), variantKey: variant.variantKey, storageKey, mimeType: variant.mimeType, byteSize: variant.bytes.length, sha256Checksum: variant.sha256Checksum, width: variant.width, height: variant.height });
    }
    await this.db.mediaAsset.create({ data: { id, kind: "IMAGE", status: "READY", provider: "LOCAL", sourceStorageKey, compatibilityFilename, originalFilename: path.basename(sourcePath), mimeType: original.mimeType, byteSize: bytes.length, sha256Checksum: processed.sourceChecksum, width: processed.sourceWidth, height: processed.sourceHeight, createdById: this.actorId, variants: { createMany: { data: variants } } } });
    this.images.set(sourcePath, id); return id;
  }

  async externalAudio(legacyAudioId: string) {
    const key = legacyAudioId.trim(); const cached = this.audio.get(key); if (cached) return cached;
    const id = stableUuid("legacy-audio", key);
    await this.db.mediaAsset.create({ data: { id, kind: "AUDIO", status: "EXTERNAL", provider: "LEGACY_EXTERNAL", sourceStorageKey: null, compatibilityFilename: null, legacyAudioId: key, originalFilename: null, mimeType: null, byteSize: null, sha256Checksum: null, width: null, height: null, durationMs: null, createdById: this.actorId } });
    this.audio.set(key, id); return id;
  }

  get imageCount() { return this.images.size; }
  get audioCount() { return this.audio.size; }
}
