import { z } from "zod";
import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { prisma } from "@/lib/prisma";
import { requirePermission, type Actor } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { TRACK_AUDIO_MAX_BYTES, trackAudioFilename } from "./track-audio-contract";

const sourceBucket = "steyoyoke-cms-media";
const deliveryBucket = "steyoyokeapp";
const s3 = new S3Client({ region: "eu-west-1" });
const sqs = new SQSClient({ region: "eu-west-1" });
const uploadSchema = z.object({ filename: z.string().max(200), size: z.number().int().positive().max(TRACK_AUDIO_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
function enabled() {
  if (process.env.CMS_AUDIO_UPLOAD_ENABLED !== "true" || !process.env.CMS_AUDIO_QUEUE_URL) throw new AppError("Audio uploads are not enabled in this environment yet.", 503, "AUDIO_NOT_ENABLED");
}
export async function reserveTrackAudio(actor: Actor, input: unknown) {
  requirePermission(actor, "track:write"); requirePermission(actor, "media:upload"); enabled();
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) throw new AppError("Choose a WAV or MP3 within the upload limit.", 422, "INVALID_AUDIO_UPLOAD");
  const data = parsed.data;
  let name: ReturnType<typeof trackAudioFilename>;
  try { name = trackAudioFilename(data.filename); } catch (error) { throw new AppError((error as Error).message, 422, "INVALID_AUDIO_NAME"); }
  const existing = await s3.send(new ListObjectsV2Command({ Bucket: deliveryBucket, Prefix: name.key, MaxKeys: 1 }));
  if (existing.Contents?.some(object => object.Key === name.key)) throw new AppError("This audio filename already exists. Choose a different filename; existing audio cannot be overwritten.", 409, "AUDIO_FILENAME_CONFLICT");
  const id = crypto.randomUUID();
  const key = `audio-originals/${id}/source.${name.extension}`;
  const mimeType = name.extension === "wav" ? "audio/wav" : "audio/mpeg";
  const checksum = Buffer.from(data.sha256, "hex").toString("base64");
  const command = new PutObjectCommand({ Bucket: sourceBucket, Key: key, ContentType: mimeType, ContentLength: data.size, ChecksumSHA256: checksum, IfNoneMatch: "*", Metadata: { "media-asset-id": id } });
  const url = await getSignedUrl(s3, command, { expiresIn: 600, unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-media-asset-id"]) });
  try {
    await prisma.$transaction(async tx => {
      await tx.mediaAsset.create({ data: { id, kind: "AUDIO", status: "UPLOADING", provider: "S3_COMPATIBLE", sourceStorageKey: key, legacyAudioId: name.identity, originalFilename: data.filename, mimeType, byteSize: data.size, sha256Checksum: data.sha256, createdById: actor.userId } });
      await tx.mediaAuditLog.create({ data: { mediaAssetId: id, actorId: actor.userId, action: "MEDIA_UPLOAD", metadata: { phase: "reserved", sourceRetained: true } } });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new AppError("This audio filename is already reserved. Choose another filename.", 409, "AUDIO_FILENAME_CONFLICT");
    throw error;
  }
  return { id, url, headers: { "Content-Type": mimeType, "If-None-Match": "*", "x-amz-checksum-sha256": checksum, "x-amz-meta-media-asset-id": id } };
}

async function ownedAsset(actor: Actor, id: string) {
  requirePermission(actor, "track:write");
  const asset = await prisma.mediaAsset.findUnique({ where: { id: z.uuid().parse(id) } });
  if (!asset || asset.createdById !== actor.userId || !asset.sourceStorageKey?.startsWith(`audio-originals/${id}/`)) throw new AppError("Upload not found.", 404, "AUDIO_UPLOAD_NOT_FOUND");
  return asset;
}
export async function completeTrackAudio(actor: Actor, id: string) {
  enabled(); const asset = await ownedAsset(actor, id);
  if (asset.status !== "UPLOADING") return trackAudioStatus(actor, id);
  const head = await s3.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: asset.sourceStorageKey!, ChecksumMode: "ENABLED" }));
  if (head.ContentLength !== asset.byteSize || head.ContentType !== asset.mimeType || head.Metadata?.["media-asset-id"] !== id || head.ChecksumSHA256 !== Buffer.from(asset.sha256Checksum!, "hex").toString("base64")) throw new AppError("Uploaded audio does not match the reserved file. Upload it again.", 422, "AUDIO_UPLOAD_MISMATCH");
  const job = await prisma.$transaction(async tx => {
    const changed = await tx.mediaAsset.updateMany({ where: { id, status: "UPLOADING" }, data: { status: "PROCESSING" } });
    if (!changed.count) return tx.mediaProcessingJob.findUniqueOrThrow({ where: { mediaAssetId: id } });
    return tx.mediaProcessingJob.create({ data: { mediaAssetId: id } });
  });
  // The committed job is authoritative. Reconciliation repairs a lost notification.
  try { await sqs.send(new SendMessageCommand({ QueueUrl: process.env.CMS_AUDIO_QUEUE_URL, MessageBody: JSON.stringify({ jobId: job.id }) })); }
  catch { console.error("cms_audio_notification_failed", { jobId: job.id }); }
  return trackAudioStatus(actor, id);
}
export async function trackAudioStatus(actor: Actor, id: string) {
  const asset = await ownedAsset(actor, id);
  return { id: asset.id, status: asset.status, originalFilename: asset.originalFilename, legacyAudioId: asset.legacyAudioId, durationMs: asset.durationMs, message: asset.status === "FAILED" ? "Audio processing failed. Upload again with a new filename or contact an administrator to retry." : null };
}
