import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { AppError } from "@/lib/errors";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 12_000;
export const MAX_IMAGE_PIXELS = 40_000_000;

export const IMAGE_VARIANTS = [
  ["ORIGINAL", null], ["LEGACY_1440", 1440], ["LEGACY_1024", 1024], ["LEGACY_512", 512],
  ["LEGACY_THUMB_256", 256], ["LEGACY_THUMB_80", 80],
] as const;

export const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export type ProcessedVariant = {
  variantKey: typeof IMAGE_VARIANTS[number][0]; bytes: Buffer; mimeType: "image/jpeg" | "image/png";
  extension: "jpg" | "png"; width: number; height: number; sha256Checksum: string;
};

export async function processImage(bytes: Buffer) {
  const imageProcessingStartedAtMs = performance.now();
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new AppError(`Image must be no larger than ${MAX_IMAGE_BYTES} bytes.`, 422, "IMAGE_SIZE_INVALID");
  let metadata: Metadata;
  const metadataStartedAtMs = performance.now();
  try { metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).metadata(); }
  catch { throw new AppError("The upload is not a valid decodable image.", 422, "IMAGE_INVALID"); }
  const metadataMs = performance.now() - metadataStartedAtMs;
  if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new AppError("Only JPEG, PNG, and WebP images are accepted.", 422, "IMAGE_FORMAT_INVALID");
  if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new AppError("Image dimensions exceed the local safety limits.", 422, "IMAGE_DIMENSIONS_INVALID");

  const oriented = sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  const hasAlpha = Boolean(metadata.hasAlpha);
  const extension = hasAlpha ? "png" as const : "jpg" as const;
  const mimeType = hasAlpha ? "image/png" as const : "image/jpeg" as const;
  const variants: ProcessedVariant[] = [];
  const variantTimings: Array<{ variantKey: ProcessedVariant["variantKey"]; processingMs: number }> = [];
  const variantProcessingStartedAtMs = performance.now();
  for (const [variantKey, size] of IMAGE_VARIANTS) {
    const variantStartedAtMs = performance.now();
    let pipeline = oriented.clone();
    if (size) pipeline = pipeline.resize({ width: size, height: size, fit: "inside", withoutEnlargement: true });
    pipeline = hasAlpha ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality: 90, mozjpeg: true });
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    variants.push({ variantKey, bytes: result.data, mimeType, extension, width: result.info.width, height: result.info.height, sha256Checksum: checksum(result.data) });
    variantTimings.push({ variantKey, processingMs: performance.now() - variantStartedAtMs });
  }
  return {
    sourceFormat: metadata.format!, sourceWidth: metadata.autoOrient.width, sourceHeight: metadata.autoOrient.height,
    sourceChecksum: checksum(bytes), variants,
    profile: {
      imageProcessingMs: performance.now() - imageProcessingStartedAtMs,
      metadataMs,
      variantProcessingMs: performance.now() - variantProcessingStartedAtMs,
      variants: variantTimings,
    },
  };
}
