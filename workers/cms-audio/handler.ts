import { Pool } from "pg";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcodeTrackAudio } from "../../src/modules/media/transcode-track-audio";
import { workerDatabaseTarget } from "./database-target";

let pool: Pool;
let initialization: Promise<void> | undefined;
async function initialize() {
  if (initialization) return initialization;
  initialization = (async () => {
    let connectionString = process.env.DATABASE_URL;
    if (process.env.CMS_AUDIO_DATABASE_SECRET_ARN) {
      const secret = await new SecretsManagerClient({ region: "eu-west-1" }).send(new GetSecretValueCommand({ SecretId: process.env.CMS_AUDIO_DATABASE_SECRET_ARN }));
      connectionString = JSON.parse(secret.SecretString!).DATABASE_URL;
    }
    if (!connectionString) throw new Error("Worker database configuration missing");
    const target = workerDatabaseTarget(connectionString, process.env.CMS_AUDIO_DATABASE_NAME, process.env.CMS_AUDIO_NEON_BRANCH_ID);
    const candidate = new Pool({ connectionString, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
    try {
      const identity = await candidate.query("SELECT current_database() AS database, current_setting('neon.branch_id',true) AS branch");
      if (identity.rows[0].database !== target.database || (target.branch && identity.rows[0].branch !== target.branch)) throw new Error("Worker branch identity mismatch");
      pool = candidate;
    } catch (error) { await candidate.end(); throw error; }
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}
const s3 = new S3Client({ region: "eu-west-1" });
const sqs = new SQSClient({ region: "eu-west-1" });
const sourceBucket = "steyoyoke-cms-media";
const deliveryBucket = "steyoyokeapp";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function hashFile(path: string) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}
async function reconcile() {
  // Lease expiry is longer than the maximum invocation, so an old process cannot
  // still be transcoding when its final attempt is declared failed.
  await pool.query(`WITH failed AS (
    UPDATE media_processing_jobs j SET status='FAILED', "lastError"='Audio worker exceeded its retry budget', "completedAt"=now(), "updatedAt"=now()
    FROM media_assets a WHERE a.id=j."mediaAssetId" AND a."sourceStorageKey" LIKE 'audio-originals/%'
    AND j.status='RUNNING' AND j.attempts >= 3 AND j."lockedAt" < now()-interval '16 minutes'
    RETURNING j."mediaAssetId"
  ) UPDATE media_assets SET status='FAILED', "failureReason"='Audio processing failed. Please retry the upload.', "updatedAt"=now() WHERE id IN (SELECT "mediaAssetId" FROM failed) AND status='PROCESSING'`);
  const { rows } = await pool.query(`SELECT j.id FROM media_processing_jobs j JOIN media_assets a ON a.id=j."mediaAssetId"
    WHERE a.kind='AUDIO' AND a.status='PROCESSING' AND a."sourceStorageKey" LIKE 'audio-originals/%' AND j.attempts < 3
    AND ((j.status='PENDING' AND j."availableAt" <= now()) OR (j.status='RUNNING' AND j."lockedAt" < now()-interval '16 minutes'))
    ORDER BY j."availableAt" LIMIT 25`);
  for (const row of rows) await sqs.send(new SendMessageCommand({ QueueUrl: process.env.CMS_AUDIO_QUEUE_URL!, MessageBody: JSON.stringify({ jobId: row.id }) }));
  return { notified: rows.length };
}
async function processJob(id: string) {
  if (!uuid.test(id)) throw new Error("Invalid job notification");
  const client = await pool.connect();
  let job;
  try {
    await client.query("BEGIN");
    const claim = await client.query(`SELECT j.*, a."sourceStorageKey", a."sha256Checksum", a."byteSize", a."legacyAudioId", a."createdById"
      FROM media_processing_jobs j JOIN media_assets a ON a.id=j."mediaAssetId"
      WHERE j.id=$1 AND a.kind='AUDIO' AND a.status='PROCESSING' AND a."sourceStorageKey" LIKE 'audio-originals/%' AND j.attempts < 3
      AND ((j.status='PENDING' AND j."availableAt" <= now()) OR (j.status='RUNNING' AND j."lockedAt" < now()-interval '16 minutes'))
      FOR UPDATE OF j SKIP LOCKED`, [id]);
    job = claim.rows[0];
    if (job) {
      const lease = await client.query(`UPDATE media_processing_jobs SET status='RUNNING', attempts=attempts+1, "lockedAt"=now(), "updatedAt"=now() WHERE id=$1 RETURNING attempts, "lockedAt"::text AS "lockedAt"`, [id]);
      Object.assign(job, lease.rows[0]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  if (!job) return;
  const started = performance.now(); const directory = await mkdtemp(join(tmpdir(), "cms-audio-"));
  try {
    if (job.sourceStorageKey !== `audio-originals/${job.mediaAssetId}/source.wav` && job.sourceStorageKey !== `audio-originals/${job.mediaAssetId}/source.mp3`) throw new Error("Invalid source identity");
    if (!/^[A-Za-z0-9_-]{1,190}$/.test(job.legacyAudioId)) throw new Error("Invalid delivery identity");
    const source = join(directory, "source"); const output = join(directory, "delivery.mp3");
    const object = await s3.send(new GetObjectCommand({ Bucket: sourceBucket, Key: job.sourceStorageKey }));
    if (object.ContentLength !== job.byteSize || object.Metadata?.["media-asset-id"] !== job.mediaAssetId) throw new Error("Source ownership or size mismatch");
    await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(source));
    if (await hashFile(source) !== job.sha256Checksum) throw new Error("Source checksum mismatch");
    const result = await transcodeTrackAudio(source, output);
    const checksum = await hashFile(output); const key = `${job.legacyAudioId}-high.mp3`;
    try {
      await s3.send(new PutObjectCommand({ Bucket: deliveryBucket, Key: key, Body: createReadStream(output), ContentLength: result.byteSize, ContentType: "audio/mpeg", ACL: "public-read", IfNoneMatch: "*", ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"), Metadata: { "media-asset-id": job.mediaAssetId, sha256: checksum } }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
      const existing = await s3.send(new HeadObjectCommand({ Bucket: deliveryBucket, Key: key, ChecksumMode: "ENABLED" }));
      if (existing.Metadata?.["media-asset-id"] !== job.mediaAssetId || existing.ChecksumSHA256 !== Buffer.from(checksum, "hex").toString("base64") || existing.ContentLength !== result.byteSize) throw new Error("Delivery filename conflict; existing audio was preserved");
    }
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const fence = await db.query(`UPDATE media_processing_jobs SET status='COMPLETED', "completedAt"=now(), "updatedAt"=now(), "lastError"=NULL
        WHERE id=$1 AND status='RUNNING' AND attempts=$2 AND "lockedAt"=$3 RETURNING id`, [id, job.attempts, job.lockedAt]);
      if (!fence.rowCount) throw new Error("Lease lost");
      const delivery = { bucket: deliveryBucket, key, codec: "mp3", bitrate: 128000, channels: 2, byteSize: result.byteSize, sha256: checksum };
      const ready = await db.query(`UPDATE media_assets SET status='READY', "audioDelivery"=$2, "durationMs"=$3, "unreferencedAt"=now(), "failureReason"=NULL, "updatedAt"=now() WHERE id=$1 AND status='PROCESSING' RETURNING id`, [job.mediaAssetId, JSON.stringify(delivery), result.durationMs]);
      if (!ready.rowCount) throw new Error("Asset lifecycle changed");
      await db.query(`INSERT INTO media_audit_logs (id,"mediaAssetId","actorId",action,metadata,"createdAt") VALUES ($1,$2,$3,'MEDIA_PROCESS',$4,now())`, [crypto.randomUUID(), job.mediaAssetId, job.createdById, JSON.stringify({ kind: "AUDIO", delivery, sourceRetained: true })]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    console.info("cms_audio_processed", { jobId: id, durationMs: Math.round(performance.now() - started), outputBytes: result.byteSize, temporaryBytes: (await stat(source)).size + result.byteSize, rssBytes: process.memoryUsage().rss });
  } catch (error) {
    // Never return raw worker errors to operators. The fenced database state is
    // retried by reconciliation; duplicate SQS notifications cannot claim it early.
    const message = error instanceof Error ? error.message.slice(0, 500) : "Audio processing failed";
    await pool.query(`WITH failed AS (UPDATE media_processing_jobs SET status=CASE WHEN attempts >= 3 THEN 'FAILED'::"MediaProcessingJobStatus" ELSE 'PENDING'::"MediaProcessingJobStatus" END,
      "availableAt"=now()+interval '60 seconds', "lastError"=$4, "updatedAt"=now()
      WHERE id=$1 AND status='RUNNING' AND attempts=$2 AND "lockedAt"=$3 RETURNING status, "mediaAssetId")
      UPDATE media_assets SET status='FAILED', "failureReason"='Audio processing failed. Please retry the upload.', "updatedAt"=now()
      WHERE id IN (SELECT "mediaAssetId" FROM failed WHERE status='FAILED') AND status='PROCESSING'`, [id, job.attempts, job.lockedAt, message]);
    console.error("cms_audio_failed", { jobId: id, message });
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function handler(event: { reconcile?: boolean; Records?: { messageId: string; body: string }[] }) {
  await initialize();
  if (event.reconcile === true) return reconcile();
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try { const body = JSON.parse(record.body); await processJob(body.jobId); }
    catch { batchItemFailures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures };
}
