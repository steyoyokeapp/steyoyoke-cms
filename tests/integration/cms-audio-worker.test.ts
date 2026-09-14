import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { handler } from "../../workers/cms-audio/handler";
type Stored = { bytes: Buffer; metadata: Record<string, string>; checksum: string };
const objects = new Map<string, Stored>();
const notifications: unknown[] = [];
let wav: Buffer; let mp3: Buffer; let userId: string; let directory: string;
const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!); if (url.hostname !== "127.0.0.1" || !url.pathname.endsWith("_test")) throw new Error("Local tests only");
  directory = await mkdtemp(join(tmpdir(), "cms-worker-test-"));
  for (const format of ["wav", "mp3"]) execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2", "-ac", "2", ...(format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "320k"] : ["-c:a", "pcm_s16le"]), join(directory, `source.${format}`)]);
  wav = await readFile(join(directory, "source.wav")); mp3 = await readFile(join(directory, "source.mp3"));
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    const request = command as { input: { Bucket: string; Key: string; Body?: AsyncIterable<Buffer>; Metadata: Record<string, string>; ACL?: string; IfNoneMatch?: string } };
    const key = `${request.input.Bucket}/${request.input.Key}`;
    if (command instanceof PutObjectCommand) {
      expect(request.input.Bucket).toBe("steyoyokeapp"); expect(request.input.ACL).toBe("public-read"); expect(request.input.IfNoneMatch).toBe("*");
      if (objects.has(key)) throw Object.assign(new Error("Precondition failed"), { $metadata: { httpStatusCode: 412 } });
      const chunks: Buffer[] = []; for await (const chunk of request.input.Body!) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); objects.set(key, { bytes, metadata: request.input.Metadata, checksum: checksum(bytes) }); return {};
    }
    const stored = objects.get(key); if (!stored) throw new Error("Missing mock object");
    if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) return { Body: Readable.from(stored.bytes), ContentLength: stored.bytes.length, Metadata: stored.metadata, ChecksumSHA256: Buffer.from(stored.checksum, "hex").toString("base64") };
    throw new Error("Unexpected AWS operation");
  });
  vi.spyOn(SQSClient.prototype, "send").mockImplementation(async command => { notifications.push(command); return {}; });
});
beforeEach(async () => {
  objects.clear(); notifications.length = 0;
  await prisma.$executeRawUnsafe('TRUNCATE users, media_assets CASCADE');
  userId = (await prisma.user.create({ data: { name: "Worker", email: "worker@test.local" } })).id;
});
afterAll(async () => { vi.restoreAllMocks(); await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }); });
async function fixture(bytes: Buffer, extension = "wav", profile = "track") {
  const id = crypto.randomUUID(); const legacyAudioId = `CMSAUDIOTEST_${id}_1`; const key = `audio-originals/${id}/${profile === "podcast" ? "podcast-source" : "source"}.${extension}`;
  objects.set(`steyoyoke-cms-media/${key}`, { bytes, metadata: { "media-asset-id": id }, checksum: checksum(bytes) });
  await prisma.mediaAsset.create({ data: { id, kind: "AUDIO", status: "PROCESSING", provider: "S3_COMPATIBLE", sourceStorageKey: key, originalFilename: `${legacyAudioId}.${extension}`, legacyAudioId, mimeType: extension === "wav" ? "audio/wav" : "audio/mpeg", byteSize: bytes.length, sha256Checksum: checksum(bytes), createdById: userId } });
  const job = await prisma.mediaProcessingJob.create({ data: { mediaAssetId: id } });
  return { id, job, key: `${legacyAudioId}-high.mp3` };
}
it.each(["wav", "mp3"])("converts %s, verifies delivery, preserves masters, and tolerates duplicate notifications", async format => {
  const asset = await fixture(format === "wav" ? wav : mp3, format);
  const event = { Records: [{ messageId: "one", body: JSON.stringify({ jobId: asset.job.id }) }] };
  expect(await handler(event)).toEqual({ batchItemFailures: [] });
  expect(await handler(event)).toEqual({ batchItemFailures: [] });
  const ready = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
  expect(ready.status).toBe("READY"); expect(ready.durationMs).toBeGreaterThan(1900);
  expect(ready.audioDelivery).toMatchObject({ key: asset.key, codec: "mp3", bitrate: 128000, channels: 2 });
  expect(objects.size).toBe(2);
  expect(await prisma.mediaProcessingJob.findUnique({ where: { id: asset.job.id } })).toMatchObject({ status: "COMPLETED", attempts: 1 });
  await expect(prisma.mediaAsset.update({ where: { id: asset.id }, data: { audioDelivery: { key: "changed" } } })).rejects.toThrow(/immutable/);
});
it("rejects historical filename collisions without overwriting or marking READY", async () => {
  const asset = await fixture(wav); const historical = Buffer.from("historical bytes");
  objects.set(`steyoyokeapp/${asset.key}`, { bytes: historical, metadata: {}, checksum: checksum(historical) });
  expect(await handler({ Records: [{ messageId: "collision", body: JSON.stringify({ jobId: asset.job.id }) }] })).toEqual({ batchItemFailures: [{ itemIdentifier: "collision" }] });
  expect(objects.get(`steyoyokeapp/${asset.key}`)?.bytes).toEqual(historical);
  expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toMatchObject({ status: "PROCESSING" });
});
it("reconciles lost notifications and never claims image jobs", async () => {
  const asset = await fixture(wav);
  expect(await handler({ reconcile: true })).toEqual({ notified: 1 }); expect(notifications).toHaveLength(1);
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { kind: "IMAGE" } });
  expect(await handler({ Records: [{ messageId: "wrong-kind", body: JSON.stringify({ jobId: asset.job.id }) }] })).toEqual({ batchItemFailures: [] });
  expect(await prisma.mediaProcessingJob.findUnique({ where: { id: asset.job.id } })).toMatchObject({ attempts: 0 });
});
it("records three failed attempts and terminates instead of leaving audio PROCESSING", async () => {
  const asset=await fixture(Buffer.from('invalid audio'));
  for(let attempt=1;attempt<=3;attempt++) {
    await prisma.mediaProcessingJob.update({where:{id:asset.job.id},data:{availableAt:new Date(Date.now()-1000)}});
    await handler({Records:[{messageId:'failure-'+attempt,body:JSON.stringify({jobId:asset.job.id})}]});
  }
  expect(await prisma.mediaProcessingJob.findUnique({where:{id:asset.job.id}})).toMatchObject({attempts:3,status:'FAILED'});
  expect(await prisma.mediaAsset.findUnique({where:{id:asset.id}})).toMatchObject({status:'FAILED'});
  expect(objects.has('steyoyokeapp/'+asset.key)).toBe(false);
});
it("reconciles an expired final lease after a killed invocation", async () => {
  const asset=await fixture(wav);
  await prisma.mediaProcessingJob.update({where:{id:asset.job.id},data:{status:'RUNNING',attempts:3,lockedAt:new Date(Date.now()-17*60000)}});
  await handler({reconcile:true});
  expect(await prisma.mediaProcessingJob.findUnique({where:{id:asset.job.id}})).toMatchObject({status:'FAILED'});
  expect(await prisma.mediaAsset.findUnique({where:{id:asset.id}})).toMatchObject({status:'FAILED'});
});
it("rejects incomplete delivery metadata instead of accepting SQL NULL checks", async () => {
  const asset=await fixture(wav);
  await expect(prisma.mediaAsset.update({where:{id:asset.id},data:{audioDelivery:{}}})).rejects.toThrow(/media_audio_delivery_contract/);
  await expect(prisma.mediaAsset.create({data:{kind:'AUDIO',status:'PROCESSING',provider:'S3_COMPATIBLE',sourceStorageKey:'audio-originals/test-invalid/source.wav',originalFilename:'test-invalid.wav',mimeType:'audio/wav',byteSize:wav.length,sha256Checksum:checksum(wav),legacyAudioId:'CMSAUDIOTEST_invalid_metadata',createdById:userId,audioDelivery:{}}})).rejects.toThrow(/media_audio_delivery_contract/);
});

it("processes the reserved Podcast source profile with identical delivery and lease guarantees", async () => {
  const asset = await fixture(wav, "wav", "podcast");
  expect(await handler({ Records: [{ messageId: "podcast", body: JSON.stringify({ jobId: asset.job.id }) }] })).toEqual({ batchItemFailures: [] });
  const ready = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
  expect(ready.status).toBe("READY"); expect(ready.sourceStorageKey).toContain("/podcast-source.wav");
  expect(ready.audioDelivery).toMatchObject({ key: asset.key, bitrate: 128000, channels: 2 });
});
