import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { AppError } from "@/lib/errors";
import { mapWithConcurrency } from "@/modules/media/concurrency";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 12_000;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const IMAGE_PROCESSING_CONCURRENCY = 2;

export const IMAGE_VARIANTS = [
  ["ORIGINAL", null], ["LEGACY_1440", 1440], ["LEGACY_1024", 1024], ["LEGACY_512", 512],
  ["LEGACY_THUMB_256", 256], ["LEGACY_THUMB_80", 80],
] as const;

export const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export type ProcessedVariant = {
  variantKey: typeof IMAGE_VARIANTS[number][0]; bytes: Buffer; mimeType: "image/jpeg" | "image/png";
  extension: "jpg" | "png"; width: number; height: number; sha256Checksum: string;
};

export async function inspectImage(bytes: Buffer) {
  const inspectionStartedAtMs = performance.now();
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new AppError(`Image must be no larger than ${MAX_IMAGE_BYTES} bytes.`, 422, "IMAGE_SIZE_INVALID");
  let metadata: Metadata;
  try { metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).metadata(); }
  catch { throw new AppError("The upload is not a valid decodable image.", 422, "IMAGE_INVALID"); }
  if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new AppError("Only JPEG, PNG, and WebP images are accepted.", 422, "IMAGE_FORMAT_INVALID");
  if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new AppError("Image dimensions exceed the local safety limits.", 422, "IMAGE_DIMENSIONS_INVALID");
  return {
    sourceFormat: metadata.format!, sourceWidth: metadata.autoOrient.width ?? metadata.width, sourceHeight: metadata.autoOrient.height ?? metadata.height,
    sourceChecksum: checksum(bytes), hasAlpha: Boolean(metadata.hasAlpha), inspectionMs: performance.now() - inspectionStartedAtMs,
  };
}

export async function processImage(bytes: Buffer) {
  const imageProcessingStartedAtMs = performance.now();
  const inspected = await inspectImage(bytes);
  const oriented = sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  const hasAlpha = inspected.hasAlpha;
  const extension = hasAlpha ? "png" as const : "jpg" as const;
  const mimeType = hasAlpha ? "image/png" as const : "image/jpeg" as const;
  const variantProcessingStartedAtMs = performance.now();
  const rendered = await mapWithConcurrency(IMAGE_VARIANTS, IMAGE_PROCESSING_CONCURRENCY, async ([variantKey, size]) => {
    const variantStartedAtMs = performance.now();
    let pipeline = oriented.clone();
    if (size) pipeline = pipeline.resize({ width: size, height: size, fit: "inside", withoutEnlargement: true });
    pipeline = hasAlpha ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality: 90, mozjpeg: true });
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      variant: { variantKey, bytes: result.data, mimeType, extension, width: result.info.width, height: result.info.height, sha256Checksum: checksum(result.data) } satisfies ProcessedVariant,
      processingMs: performance.now() - variantStartedAtMs,
    };
  });
  return {
    sourceFormat: inspected.sourceFormat, sourceWidth: inspected.sourceWidth, sourceHeight: inspected.sourceHeight,
    sourceChecksum: inspected.sourceChecksum, variants: rendered.map(({ variant }) => variant),
    profile: {
      imageProcessingMs: performance.now() - imageProcessingStartedAtMs,
      metadataMs: inspected.inspectionMs,
      variantProcessingMs: performance.now() - variantProcessingStartedAtMs,
      variants: rendered.map(({ variant, processingMs }) => ({ variantKey: variant.variantKey, processingMs })),
    },
  };
}
