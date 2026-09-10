import { parseBuffer } from "music-metadata";
import { AppError } from "@/lib/errors";
import { checksum } from "@/modules/media/image";

export const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 24 * 60 * 60 * 1000;

export async function processAudio(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new AppError(`Audio must be non-empty and no larger than ${MAX_AUDIO_BYTES} bytes.`, 422, "AUDIO_SIZE_INVALID");
  try {
    const metadata = await parseBuffer(bytes, undefined, { duration: true, skipCovers: true });
    const { container, codec, duration, hasAudio, hasVideo } = metadata.format;
    if (!hasAudio || hasVideo || container !== "MPEG" || !codec?.includes("Layer 3")) throw new Error("unsupported audio");
    const durationMs = Math.round((duration ?? 0) * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_DURATION_MS) throw new Error("invalid duration");
    return { mimeType: "audio/mpeg" as const, extension: "mp3" as const, durationMs, sha256Checksum: checksum(bytes) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Only valid MP3 audio with a measurable duration is accepted.", 422, "AUDIO_INVALID");
  }
}
