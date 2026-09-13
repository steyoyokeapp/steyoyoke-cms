import sharp from "sharp";
import { DatabasePool } from "@/lib/database-pool";
import ArtistPage from "@/app/admin/artists/[id]/page";
import TrackPage from "@/app/admin/tracks/[id]/page";
import PodcastPage from "@/app/admin/podcasts/[id]/page";
import ReleasePage from "@/app/admin/releases/[id]/page";

const pageActor = vi.hoisted(() => ({ userId: "", role: "VIEWER" as const }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/session", () => ({ actorForPage: async () => pageActor }));
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { createArtist, getArtist, publishArtist, updateArtistDraft } from "@/modules/artists/service";
import { assertReadyArtwork, createAndProcessImage, getMediaReferences, listMediaAssets, listMediaOptions, permanentlyDeleteMedia, purgeEligibleMedia, readMediaSource, retireMedia, retryImageProcessing } from "@/modules/media/service";
import type { StorageProvider } from "@/modules/media/storage";
import { runMediaProcessingJobs } from "@/modules/media/image-worker";
import { checksum } from "@/modules/media/image";
import { createPodcast, getPodcast, publishPodcast, updatePodcastDraft } from "@/modules/podcasts/service";
import { createRelease, getRelease, publishRelease, replaceReleaseTracks, updateReleaseDraft } from "@/modules/releases/service";
import { createTrack, getTrack, publishTrack, updateTrackDraft } from "@/modules/tracks/service";
import { GET as getLegacyMedia } from "@/app/assets/uploads/files/[...path]/route";
import { localStorage } from "@/modules/media/storage";
import { MigrationMediaImporter } from "../../scripts/migration/media";
import { checkpoint } from "../../scripts/migration/ownership";
import { generateRollbackManifest } from "../../scripts/migration/rollback";

class MemoryStorage implements StorageProvider {
  constructor(readonly kind: "LOCAL" | "S3_COMPATIBLE" = "LOCAL") {}
  files = new Map<string, Buffer>();
  ownershipTokens = new Map<string, string>();
  putCalls = new Map<string, number>();
  async put(key: string, bytes: Buffer, options: { ownershipToken?: string } = {}) { this.putCalls.set(key, (this.putCalls.get(key) ?? 0) + 1); if (this.files.has(key)) throw new Error("immutable collision"); this.files.set(key, bytes); if (options.ownershipToken) this.ownershipTokens.set(key, options.ownershipToken.toLowerCase()); }
  async read(key: string) { const value = this.files.get(key); if (!value) throw new Error("missing"); return value; }
  async exists(key: string) { return this.files.has(key); }
  async getOwnershipToken(key: string) { return this.ownershipTokens.get(key) ?? null; }
  async delete(key: string) { this.files.delete(key); this.ownershipTokens.delete(key); }
}

let editor: Actor; let admin: Actor; let viewer: Actor; let labelId: string; let image: Buffer;
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "migration_records", "migration_issues", "migration_runs", "media_audit_logs", "media_variants", "media_assets", "release_audit_logs", "release_revision_tracks", "release_revisions", "release_tracks", "releases", "podcast_audit_logs", "podcast_chapter_revisions", "podcast_episode_revisions", "podcast_chapters", "podcast_episodes", "track_audit_logs", "track_revisions", "tracks", "audit_logs", "artist_revisions", "artists", "accounts", "sessions", "verifications", "users", "labels" RESTART IDENTITY CASCADE');
  const editorUser = await prisma.user.create({ data: { name: "Editor", email: "media-editor@test.local", role: "EDITOR", emailVerified: true } }); const adminUser = await prisma.user.create({ data: { name: "Admin", email: "media-admin@test.local", role: "ADMIN", emailVerified: true } }); const viewerUser = await prisma.user.create({ data: { name: "Viewer", email: "media-viewer@test.local", role: "VIEWER", emailVerified: true } });
  pageActor.userId = viewerUser.id;
  editor = { userId: editorUser.id, role: "EDITOR" }; admin = { userId: adminUser.id, role: "ADMIN" }; viewer = { userId: viewerUser.id, role: "VIEWER" }; labelId = (await prisma.label.create({ data: { name: "Steyoyoke", slug: "steyoyoke", legacyValue: "STEYOYOKE" } })).id;
  image = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#7a2255" } }).jpeg().toBuffer();
});
afterAll(async () => prisma.$disconnect());

async function media(storage: StorageProvider = new MemoryStorage(), name = "artwork.jpg") {
  const processing = await createAndProcessImage(editor, { name, bytes: image }, storage);
  expect(await runMediaProcessingJobs({ limit: 1, mediaAssetId: processing.id, storage })).toMatchObject({ completed: 1 });
  return prisma.mediaAsset.findUniqueOrThrow({ where: { id: processing.id }, include: { variants: { orderBy: { variantKey: "asc" } }, createdBy: { select: { id: true, name: true } } } });
}

describe("media service and frozen artwork references", () => {
  it("durably ingests the source and returns PROCESSING before variants exist", async () => {
    const storage = new MemoryStorage();
    const asset = await createAndProcessImage(editor, { name: "async.jpg", bytes: image }, storage);
    expect(asset).toMatchObject({ status: "PROCESSING", variants: [] });
    expect(storage.files.size).toBe(1);
    expect(await prisma.mediaProcessingJob.findUnique({ where: { mediaAssetId: asset.id } })).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await readMediaSource(editor, asset.id, storage)).bytes).toEqual(image);
    await expect(assertReadyArtwork(prisma, asset.id, false)).rejects.toMatchObject({ code: "ARTWORK_NOT_READY" });

    expect(await runMediaProcessingJobs({ limit: 1, mediaAssetId: asset.id, storage })).toMatchObject({ examined: 1, completed: 1 });
    const ready = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id }, include: { variants: true, processingJob: true } });
    expect(ready).toMatchObject({ status: "READY", processingJob: { status: "COMPLETED", attempts: 1 } });
    expect(ready.variants).toHaveLength(6); expect(storage.files.size).toBe(7);
    expect(storage.files.get(asset.sourceStorageKey!)).toEqual(image);
    expect(storage.files.get(ready.variants.find(({ variantKey }) => variantKey === "ORIGINAL")!.storageKey)).not.toEqual(image);
  });

  it("serves a pending source with its uploaded format rather than its normalized output format", async () => {
    const storage = new MemoryStorage();
    const webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#7a2255" } }).webp().toBuffer();
    const asset = await createAndProcessImage(editor, { name: "pending.webp", bytes: webp }, storage);
    expect(asset).toMatchObject({ status: "PROCESSING", mimeType: "image/jpeg" });
    expect(await readMediaSource(editor, asset.id, storage)).toEqual({ bytes: webp, mimeType: "image/webp" });
  });

  it("creates immutable READY metadata, six variants, checksums, safe keys, and one upload audit", async () => {
    const storage = new MemoryStorage(); const asset = await media(storage, "../user supplied name.jpg");
    expect(asset.status).toBe("READY"); expect(asset.variants).toHaveLength(6); expect(asset.compatibilityFilename).toMatch(/^[0-9a-f-]+\.jpg$/); expect(asset.sourceStorageKey).toMatch(/^images\/[0-9a-f-]+\/source\.jpg$/);
    expect(asset.variants.find(({ variantKey }) => variantKey === "LEGACY_1440")).toMatchObject({ width: 400, height: 500 }); expect(asset.variants.find(({ variantKey }) => variantKey === "LEGACY_THUMB_80")).toMatchObject({ width: 64, height: 80 }); expect(storage.files.size).toBe(7);
    expect(await prisma.mediaAuditLog.count({ where: { mediaAssetId: asset.id, action: "MEDIA_UPLOAD" } })).toBe(1);
    expect(await prisma.mediaAuditLog.count({ where: { mediaAssetId: asset.id, action: "MEDIA_PROCESS" } })).toBe(1);
    await expect(prisma.mediaAsset.update({ where: { id: asset.id }, data: { sha256Checksum: "b".repeat(64) } })).rejects.toThrow(/immutable/); await expect(prisma.mediaVariant.update({ where: { id: asset.variants[0]!.id }, data: { width: 9 } })).rejects.toThrow(/immutable/);
  });

  it("emits one safe structured profile event for an S3-compatible image upload", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const storage = new MemoryStorage("S3_COMPATIBLE");
    const asset = await createAndProcessImage(editor, { name: "private-filename.jpg", bytes: image }, storage, { requestId: "iad1::profile-test", parseMs: 1.25 });
    await runMediaProcessingJobs({ limit: 1, mediaAssetId: asset.id, storage });
    const records = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    const ingest = records.find(({ event }) => event === "media_image_ingest_profile");
    const processing = records.find(({ event }) => event === "media_image_processing_profile");
    expect(ingest).toMatchObject({ requestId: "iad1::profile-test", operation: "image ingest", storageProvider: "S3_COMPATIBLE", parseMs: 1.25, inputByteSize: image.length, inputWidth: 400, inputHeight: 500 });
    for (const field of ["totalMs", "validationMs", "dbCreateMs", "sourceWriteMs", "enqueueMs"]) expect(ingest[field]).toEqual(expect.any(Number));
    expect(processing).toMatchObject({ operation: "image representation processing", storageProvider: "S3_COMPATIBLE", variantCount: 6, inputByteSize: image.length, inputWidth: 400, inputHeight: 500 });
    for (const field of ["totalMs", "queueDelayMs", "imageProcessingMs", "metadataMs", "variantProcessingMs", "storageWriteMs", "s3WriteMs", "dbVariantWriteMs", "finalizeMs", "variantProcessingMs_ORIGINAL", "variantStorageWriteMs_ORIGINAL"]) expect(processing[field]).toEqual(expect.any(Number));
    expect(JSON.stringify({ ingest, processing })).not.toContain("private-filename.jpg");
    output.mockRestore();
  });

  it("retries safely, becomes FAILED after bounded attempts, then reaches READY after an explicit retry", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new MemoryStorage(); let failVariants = true;
    const put = storage.put.bind(storage);
    storage.put = async (key, bytes) => { if (failVariants && !key.includes("/source.")) throw new Error("representation write failed"); await put(key, bytes); };
    const asset = await createAndProcessImage(editor, { name: "retry.jpg", bytes: image }, storage);
    for (let attempt = 0; attempt < 3; attempt += 1) await runMediaProcessingJobs({ limit: 1, mediaAssetId: asset.id, storage, now: new Date(Date.now() + attempt * 3_600_000) });
    expect(await prisma.mediaProcessingJob.findUnique({ where: { mediaAssetId: asset.id } })).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toMatchObject({ status: "FAILED", failureReason: "Image representation processing failed." });

    failVariants = false;
    expect(await retryImageProcessing(editor, asset.id)).toMatchObject({ status: "PROCESSING" });
    expect(await runMediaProcessingJobs({ limit: 1, mediaAssetId: asset.id, storage })).toMatchObject({ completed: 1 });
    expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toMatchObject({ status: "READY", failureReason: null });
    expect(await prisma.mediaVariant.count({ where: { mediaAssetId: asset.id } })).toBe(6);
    expect(await runMediaProcessingJobs({ limit: 1, mediaAssetId: asset.id, storage })).toMatchObject({ examined: 0, completed: 0 });
    expect(await prisma.mediaAuditLog.count({ where: { mediaAssetId: asset.id, action: "MEDIA_PROCESS" } })).toBe(1);
    output.mockRestore();
  });

  it("preserves migration storage ownership when finalization rolls back and the same run reuses immutable variants", async () => {
    const storage = new MemoryStorage();
    const asset = await createAndProcessImage(editor, { name: "finalization-timeout.jpg", bytes: image }, storage);
    const runId = crypto.randomUUID(); const sourceIdentity = "test/finalization-timeout.jpg:" + checksum(image);
    await prisma.migrationRun.create({ data: { id: runId, sourceSha256: "a".repeat(64), scopeKey: "test-storage-provenance", toolingVersion: "test" } });
    await checkpoint(prisma, runId, "IMAGE", sourceIdentity, { canonicalId: asset.id, stage: "JOB_PENDING", status: "PROCESSING", metadata: { createdByRun: true, sourceStorageKey: asset.sourceStorageKey, sourceCreatedByRun: false } });

    let transactions = 0;
    const failingDb = new Proxy(prisma, { get(target, property, receiver) {
      if (property === "$transaction") return async (operation: (tx: never) => Promise<unknown>, options?: unknown) => {
        transactions += 1;
        if (transactions !== 2) return target.$transaction(operation as never, options as never);
        return target.$transaction(async (tx) => { await operation(tx as never); throw new Error("injected finalization timeout"); }, options as never);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await runMediaProcessingJobs({ limit: 1, mediaAssetId: asset.id, storage, db: failingDb, storageOwnershipToken: runId, auditMetadata: { migrationRunId: runId } })).toMatchObject({ retryPending: 1 });
    expect(await prisma.mediaVariant.count({ where: { mediaAssetId: asset.id } })).toBe(0);
    expect(await prisma.mediaAuditLog.count({ where: { mediaAssetId: asset.id, action: "MEDIA_PROCESS" } })).toBe(0);
    expect([...storage.files.keys()].filter((key) => !key.includes("/source."))).toHaveLength(6);

    await prisma.mediaProcessingJob.update({ where: { mediaAssetId: asset.id }, data: { availableAt: new Date(0) } });
    await new MigrationMediaImporter(prisma, storage, editor.userId, runId, process.cwd()).processImages();
    const variantRecords = await prisma.migrationRecord.findMany({ where: { runId, entityType: "IMAGE_VARIANT" } });
    expect(variantRecords).toHaveLength(6);
    expect(variantRecords.every((record) => (record.metadata as { storageCreatedByRun?: boolean }).storageCreatedByRun === true)).toBe(true);
    expect((await generateRollbackManifest(prisma, runId)).owned.storageKeys).toHaveLength(6);
    expect([...storage.putCalls.entries()].filter(([key]) => !key.includes("/source.")).every(([, calls]) => calls === 2)).toBe(true);
    expect([...storage.files.keys()].filter((key) => !key.includes("/source."))).toHaveLength(6);
  });

  it("recovers stale claims and keeps concurrent worker invocation idempotent", async () => {
    const firstStorage = new MemoryStorage();
    const stale = await createAndProcessImage(editor, { name: "stale.jpg", bytes: image }, firstStorage);
    await prisma.mediaProcessingJob.update({ where: { mediaAssetId: stale.id }, data: { status: "RUNNING", lockedAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await runMediaProcessingJobs({ limit: 1, mediaAssetId: stale.id, storage: firstStorage })).toMatchObject({ completed: 1 });

    const secondStorage = new MemoryStorage();
    const duplicate = await createAndProcessImage(editor, { name: "duplicate.jpg", bytes: image }, secondStorage);
    const outcomes = await Promise.all([
      runMediaProcessingJobs({ limit: 1, mediaAssetId: duplicate.id, storage: secondStorage }),
      runMediaProcessingJobs({ limit: 1, mediaAssetId: duplicate.id, storage: secondStorage }),
    ]);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.completed, 0)).toBe(1);
    expect(await prisma.mediaVariant.count({ where: { mediaAssetId: duplicate.id } })).toBe(6);
    expect(await prisma.mediaAuditLog.count({ where: { mediaAssetId: duplicate.id, action: "MEDIA_PROCESS" } })).toBe(1);
  });

  it("rejects corrupt uploads without partial READY state", async () => {
    await expect(createAndProcessImage(editor, { name: "fake.jpg", bytes: Buffer.from("not-image") }, new MemoryStorage())).rejects.toMatchObject({ code: "IMAGE_INVALID" }); expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it("logs an unexpected storage failure with safe request and stage context", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new MemoryStorage(); storage.put = async () => { throw new Error("S3 write denied"); };
    await expect(createAndProcessImage(editor, { name: "artwork.jpg", bytes: image }, storage, { requestId: "iad1::media-test" })).rejects.toMatchObject({ code: "IMAGE_UPLOAD_FAILED", message: "Image upload failed cleanly." });

    const record = JSON.parse(String(output.mock.calls.find(([line]) => String(line).includes("media_image_upload_failed"))?.[0]));
    expect(record).toMatchObject({ event: "media_image_upload_failed", requestId: "iad1::media-test", operation: "image upload", failureKind: "storage", failureStage: "write_source", storageProvider: "LOCAL", errorName: "Error", errorMessage: "S3 write denied" });
    expect(record).not.toHaveProperty("bytes");
    expect(await prisma.mediaAsset.findFirst()).toMatchObject({ status: "FAILED", failureReason: "Image source ingest failed." });
    output.mockRestore();
  });

  it("accepts materialized S3 media while preserving provider integrity checks", async () => {
    const materialized = { originalFilename: "remote.jpg", mimeType: "image/jpeg", byteSize: 320_000, sha256Checksum: "d".repeat(64), width: 400, height: 500, createdById: editor.userId };
    const asset = await prisma.mediaAsset.create({ data: { ...materialized, kind: "IMAGE", status: "PROCESSING", provider: "S3_COMPATIBLE", sourceStorageKey: `images/${crypto.randomUUID()}/source.jpg`, compatibilityFilename: `${crypto.randomUUID()}.jpg` } });
    expect(asset).toMatchObject({ provider: "S3_COMPATIBLE", status: "PROCESSING" });

    async function expectProviderIntegrity(operation: Promise<unknown>) {
      try { await operation; expect.unreachable("provider integrity constraint should reject the row"); }
      catch (error) { expect(error).toMatchObject({ code: "P2039" }); expect(String(error)).toContain("media_assets_provider_integrity"); }
    }
    await expectProviderIntegrity(prisma.mediaAsset.create({ data: { ...materialized, kind: "IMAGE", status: "PROCESSING", provider: "S3_COMPATIBLE", sourceStorageKey: null, compatibilityFilename: `${crypto.randomUUID()}.jpg` } }));
    await expectProviderIntegrity(prisma.mediaAsset.create({ data: { kind: "AUDIO", status: "READY", provider: "LEGACY_EXTERNAL", legacyAudioId: crypto.randomUUID(), createdById: editor.userId } }));
  });

  it("permanently deletes only an eligible retired asset and preserves an audit tombstone", async () => {
    const storage = new MemoryStorage("S3_COMPATIBLE"); const asset = await media(storage);
    await expect(permanentlyDeleteMedia(editor, asset.id, storage)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(permanentlyDeleteMedia(viewer, asset.id, storage)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(permanentlyDeleteMedia(admin, asset.id, storage)).rejects.toMatchObject({ code: "MEDIA_DELETE_NOT_RETIRED" });
    await retireMedia(admin, asset.id);
    expect((await readMediaSource(admin, asset.id, storage)).bytes).toEqual(image);
    await prisma.mediaProcessingJob.update({ where: { mediaAssetId: asset.id }, data: { status: "FAILED" } });
    expect(await permanentlyDeleteMedia(admin, asset.id, storage)).toMatchObject({ id: asset.id, deleted: true, alreadyDeleted: false, deletedObjectCount: 7 });
    expect(storage.files.size).toBe(0);
    expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toBeNull();
    expect(await prisma.mediaVariant.count({ where: { mediaAssetId: asset.id } })).toBe(0);
    expect(await prisma.mediaProcessingJob.count({ where: { mediaAssetId: asset.id } })).toBe(0);
    expect(await prisma.mediaAuditLog.findFirst({ where: { action: "MEDIA_DELETE", metadata: { path: ["mediaAssetId"], equals: asset.id } } })).toMatchObject({ mediaAssetId: null, actorId: admin.userId, action: "MEDIA_DELETE", metadata: { mediaAssetId: asset.id, kind: "IMAGE", formerStatus: "RETIRED", deletedVariantCount: 6, deletedObjectCount: 7 } });
    expect(await permanentlyDeleteMedia(admin, asset.id, storage)).toMatchObject({ deleted: false, alreadyDeleted: true });
  });

  it("preserves the database recovery path when any owned storage deletion fails", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new MemoryStorage(); const asset = await media(storage); await retireMedia(admin, asset.id);
    const remove = storage.delete.bind(storage); let calls = 0;
    storage.delete = async (key) => { calls += 1; if (calls === 2) throw new Error("storage unavailable"); await remove(key); };
    await expect(permanentlyDeleteMedia(admin, asset.id, storage)).rejects.toMatchObject({ code: "MEDIA_DELETE_STORAGE_FAILED" });
    expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toMatchObject({ status: "RETIRED" });
    expect(await prisma.mediaVariant.count({ where: { mediaAssetId: asset.id } })).toBe(6);
    expect(await prisma.mediaProcessingJob.count({ where: { mediaAssetId: asset.id } })).toBe(1);
    expect(output.mock.calls.some(([line]) => String(line).includes("media_permanent_delete_storage_failed"))).toBe(true);
    output.mockRestore();
  });

  it("blocks historical references and running jobs, and a retired asset cannot be resurrected", async () => {
    const referencedStorage = new MemoryStorage(); const referenced = await media(referencedStorage);
    const artist = await createArtist(editor, { name: "Historical reference", imageAssetId: referenced.id });
    await publishArtist(editor, artist.id, { expectedWorkingVersion: 1 });
    await prisma.mediaAsset.update({ where: { id: referenced.id }, data: { status: "RETIRED", retiredAt: new Date() } });
    await expect(permanentlyDeleteMedia(admin, referenced.id, referencedStorage)).rejects.toMatchObject({ code: "MEDIA_REFERENCED", details: { references: expect.arrayContaining([expect.objectContaining({ type: "ARTIST_REVISION" })]) } });

    const processingStorage = new MemoryStorage();
    const processing = await createAndProcessImage(editor, { name: "running.jpg", bytes: image }, processingStorage);
    await prisma.mediaAsset.update({ where: { id: processing.id }, data: { status: "RETIRED", retiredAt: new Date() } });
    await prisma.mediaProcessingJob.update({ where: { mediaAssetId: processing.id }, data: { status: "RUNNING", lockedAt: new Date() } });
    await expect(permanentlyDeleteMedia(admin, processing.id, processingStorage)).rejects.toMatchObject({ code: "MEDIA_JOB_RUNNING" });
    expect(await runMediaProcessingJobs({ limit: 1, mediaAssetId: processing.id, storage: processingStorage })).toMatchObject({ examined: 0, completed: 0 });
    expect(await prisma.mediaAsset.findUnique({ where: { id: processing.id } })).toMatchObject({ status: "RETIRED" });
    expect(await prisma.mediaVariant.count({ where: { mediaAssetId: processing.id } })).toBe(0);
  });

  it("delivers only known virtual legacy variants with immutable cache headers", async () => {
    const asset = await media(localStorage, "route.jpg");
    const response = await getLegacyMedia(new Request(`http://local/assets/uploads/files/512/${asset.compatibilityFilename}`), { params: Promise.resolve({ path: ["512", asset.compatibilityFilename] }) } as never);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/jpeg"); expect(response.headers.get("cache-control")).toContain("immutable"); expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await getLegacyMedia(new Request("http://local/assets/uploads/files/../secret"), { params: Promise.resolve({ path: ["..", "secret"] }) } as never)).status).toBe(404);
    expect((await getLegacyMedia(new Request(`http://local/assets/uploads/files/unknown/${asset.compatibilityFilename}`), { params: Promise.resolve({ path: ["unknown", asset.compatibilityFilename] }) } as never)).status).toBe(404);
    await Promise.all([localStorage.delete(asset.sourceStorageKey!), ...asset.variants.map(({ storageKey }) => localStorage.delete(storageKey))]);
  });

  it("freezes Artist, Track, Podcast, and Release artwork independently from working drafts", async () => {
    const [a, b] = await Promise.all([media(new MemoryStorage(), "a.jpg"), media(new MemoryStorage(), "b.jpg")]);
    const artist = await createArtist(editor, { name: "Media Artist", imageAssetId: a.id }); await publishArtist(editor, artist.id, { expectedWorkingVersion: 1 }); await updateArtistDraft(editor, artist.id, { name: artist.name, slug: artist.slug, imageAssetId: b.id, expectedWorkingVersion: 1 }); expect((await getArtist(editor, artist.id)).publishedRevision?.imageAssetId).toBe(a.id); await publishArtist(editor, artist.id, { expectedWorkingVersion: 2 }); expect((await getArtist(editor, artist.id)).publishedRevision?.imageAssetId).toBe(b.id);
    const track = await createTrack(editor, { title: "Media Track", primaryArtistId: artist.id, labelId, artworkAssetId: a.id }); await publishTrack(editor, track.id, { expectedWorkingVersion: 1 }); await updateTrackDraft(editor, track.id, { title: track.title, primaryArtistId: artist.id, labelId, artworkAssetId: b.id, expectedWorkingVersion: 1 }); expect((await getTrack(editor, track.id)).publishedRevision?.artworkAssetId).toBe(a.id); await publishTrack(editor, track.id, { expectedWorkingVersion: 2 });
    const audio = await prisma.mediaAsset.create({ data: { kind: "AUDIO", status: "READY", provider: "LOCAL", sourceStorageKey: `tests/${crypto.randomUUID()}.mp3`, legacyAudioId: crypto.randomUUID(), originalFilename: "test.mp3", mimeType: "audio/mpeg", byteSize: 3, sha256Checksum: "c".repeat(64), durationMs: 1000, createdById: editor.userId } });
    const podcast = await createPodcast(editor, { title: "Media Podcast", primaryArtistId: artist.id, labelId, episodeDate: "2026-09-10", artworkAssetId: a.id, audioAssetId: audio.id }); await publishPodcast(editor, podcast.id, { expectedWorkingVersion: 1 }); await updatePodcastDraft(editor, podcast.id, { title: podcast.title, primaryArtistId: artist.id, labelId, episodeDate: "2026-09-10", artworkAssetId: b.id, expectedWorkingVersion: 1 }); expect((await getPodcast(editor, podcast.id)).publishedRevision?.artworkAssetId).toBe(a.id); await publishPodcast(editor, podcast.id, { expectedWorkingVersion: 2 });
    const release = await createRelease(editor, { title: "Media Release", primaryArtistId: artist.id, labelId, releaseDate: "2026-09-10", artworkAssetId: a.id }); await replaceReleaseTracks(editor, release.id, { expectedWorkingVersion: 1, trackIds: [track.id] }); await publishRelease(editor, release.id, { expectedWorkingVersion: 2 }); await updateReleaseDraft(editor, release.id, { title: release.title, primaryArtistId: artist.id, labelId, releaseDate: "2026-09-10", artworkAssetId: b.id, expectedWorkingVersion: 2 }); expect((await getRelease(editor, release.id)).publishedRevision?.artworkAssetId).toBe(a.id); await publishRelease(editor, release.id, { expectedWorkingVersion: 3 }); expect((await getRelease(editor, release.id)).publishedRevision?.artworkAssetId).toBe(b.id);
    const referenceTypes = new Set([...(await getMediaReferences(editor, a.id)), ...(await getMediaReferences(editor, b.id))].map(({ type }) => type));
    expect(referenceTypes).toEqual(new Set(["ARTIST_WORKING", "ARTIST_REVISION", "TRACK_WORKING", "TRACK_REVISION", "PODCAST_WORKING", "PODCAST_REVISION", "RELEASE_WORKING", "RELEASE_REVISION"]));
    const audioTrack = await createTrack(editor, { title: "Audio refs", primaryArtistId: artist.id, labelId, audioAssetId: audio.id });
    await publishTrack(editor, audioTrack.id, { expectedWorkingVersion: 1 });
    const listing = await listMediaAssets(viewer);
    for (const asset of [a, b, audio]) {
      const exact = await getMediaReferences(viewer, asset.id);
      expect(listing.items.find(x => x.id === asset.id)?.referenceCount).toBe(exact.length);
    }
    expect(new Set((await getMediaReferences(viewer, audio.id)).map(x => x.type))).toEqual(new Set(["TRACK_AUDIO_WORKING", "TRACK_AUDIO_REVISION", "PODCAST_AUDIO_WORKING", "PODCAST_AUDIO_REVISION"]));
    // No client count is accepted: newly attached media must be blocked at action time.
    await expect(retireMedia(admin, b.id)).rejects.toMatchObject({ code: "MEDIA_REFERENCED" });
    const queries = vi.spyOn(DatabasePool.prototype, "query");
    const pages = [["Artist", ArtistPage, artist.id], ["Track", TrackPage, track.id], ["Podcast", PodcastPage, podcast.id], ["Release", ReleasePage, release.id]] as const;
    try {
      const before: number[] = [];
      for (const [, page, id] of pages) { queries.mockClear(); await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }); before.push(queries.mock.calls.length); }
      await prisma.mediaAsset.createMany({ data: Array.from({ length: 3338 }, (_, i) => mediaFixture(i % 2 ? "IMAGE" : "AUDIO", "READY")) });
      for (const [i, [name, page, id]] of pages.entries()) {
        queries.mockClear(); await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
        expect(queries.mock.calls.length).toBe(before[i]); expect(queries.mock.calls.length).toBeLessThan(50);
        console.info(`${name} detail SQL queries before/after 3338 extra assets:`, before[i], queries.mock.calls.length);
      }
    } finally { queries.mockRestore(); }

  });

  it("allows incomplete drafts but blocks Podcast and Release publication without READY artwork", async () => {
    const artist = await createArtist(editor, { name: "Required Artist" }); await publishArtist(editor, artist.id, { expectedWorkingVersion: 1 }); const track = await createTrack(editor, { title: "Optional Track", primaryArtistId: artist.id, labelId }); await publishTrack(editor, track.id, { expectedWorkingVersion: 1 });
    const podcast = await createPodcast(editor, { title: "Draft Podcast", primaryArtistId: artist.id, labelId, episodeDate: "2026-09-10" }); await expect(publishPodcast(editor, podcast.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "ARTWORK_REQUIRED" });
    const release = await createRelease(editor, { title: "Draft Release", primaryArtistId: artist.id, labelId, releaseDate: "2026-09-10" }); await replaceReleaseTracks(editor, release.id, { expectedWorkingVersion: 1, trackIds: [track.id] }); await expect(publishRelease(editor, release.id, { expectedWorkingVersion: 2 })).rejects.toMatchObject({ code: "ARTWORK_REQUIRED" });
  });

  it("re-checks references and purges only after the 30-day retention boundary", async () => {
    const storage = new MemoryStorage(); const asset = await media(storage); const created = asset.unreferencedAt!;
    expect(await purgeEligibleMedia(admin, new Date(created.getTime() + 30 * 86400000 - 1), storage)).toEqual({ examined: 0, purged: 0 }); expect(await purgeEligibleMedia(admin, new Date(created.getTime() + 31 * 86400000), storage)).toEqual({ examined: 1, purged: 1 }); expect(storage.files.size).toBe(0); expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toBeNull();
    expect(await prisma.mediaAuditLog.findFirst({ where: { action: "MEDIA_PURGE", metadata: { path: ["mediaAssetId"], equals: asset.id } } })).toMatchObject({ mediaAssetId: null, action: "MEDIA_PURGE" });
  });
});


function mediaFixture(kind: "IMAGE" | "AUDIO", status: "READY" | "RETIRED" | "EXTERNAL" | "PROCESSING" | "FAILED") {
  const id = crypto.randomUUID();
  if (status === "EXTERNAL") return { id, kind, status, provider: "LEGACY_EXTERNAL" as const, legacyAudioId: id, createdById: editor.userId };
  return { id, kind, status, provider: "LOCAL" as const, sourceStorageKey: `tests/${id}`, originalFilename: id,
    mimeType: kind === "IMAGE" ? "image/jpeg" : "audio/mpeg", byteSize: 100, sha256Checksum: "c".repeat(64),
    compatibilityFilename: kind === "IMAGE" ? `${id}.jpg` : null, legacyAudioId: kind === "AUDIO" ? id : null,
    width: kind === "IMAGE" ? 100 : null, height: kind === "IMAGE" ? 100 : null, durationMs: kind === "AUDIO" ? 1000 : null, createdById: editor.userId };
}

describe("bounded media queries", () => {
  it("filters and paginates in SQL, caps limits, and never enumerates references", async () => {
    await prisma.mediaAsset.createMany({ data: Array.from({ length: 120 }, (_, i) => ({
      ...mediaFixture(i % 2 ? "IMAGE" : "AUDIO", i < 20 ? "RETIRED" : "READY"), originalFilename: `page-${i}`, createdAt: new Date(2026, 0, 1),
    })) });
    const references = vi.spyOn(prisma.artist, "findMany");
    const queries = vi.spyOn(DatabasePool.prototype, "query");
    try {
      const small = await listMediaAssets(viewer, { limit: 5 }); const smallCount = queries.mock.calls.length;
      queries.mockClear();
      const first = await listMediaAssets(viewer); const firstCount = queries.mock.calls.length;
      expect(first).toMatchObject({ total: 100, page: 1, pageCount: 2, counts: { active: 100, retired: 20 } });
      expect(first.items).toHaveLength(50); expect(small.items).toHaveLength(5);
      expect(firstCount).toBe(smallCount); expect(firstCount).toBeLessThan(10);
      const second = await listMediaAssets(viewer, { page: 2 });
      expect(new Set([...first.items, ...second.items].map(x => x.id)).size).toBe(100);
      expect(first.items.every(x => x.status !== "RETIRED" && x.referenceCount === 0 && !("references" in x))).toBe(true);
      expect((await listMediaAssets(viewer, { limit: 10000 })).items).toHaveLength(50);
      expect((await listMediaAssets(viewer, { page: 10000 })).page).toBe(2);
      for (const kind of ["IMAGE", "AUDIO"] as const) {
        const active = await listMediaAssets(viewer, { kind });
        expect(active.items).toHaveLength(50); expect(active.items.every(x => x.kind === kind && x.status === "READY")).toBe(true);
        const retired = await listMediaAssets(viewer, { view: "RETIRED", kind });
        expect(retired.items).toHaveLength(10); expect(retired.items.every(x => x.kind === kind && x.status === "RETIRED")).toBe(true);
      }
      expect(references).not.toHaveBeenCalled();
      await prisma.mediaAsset.createMany({ data: Array.from({ length: 3218 }, () => mediaFixture("IMAGE", "READY")) });
      queries.mockClear();
      const productionScale = await listMediaAssets(viewer);
      expect(productionScale.items).toHaveLength(50);
      expect(productionScale.total).toBe(3318); // 3338 assets, of which 20 are retired.
      expect(queries.mock.calls.length).toBe(firstCount);
      expect(references).not.toHaveBeenCalled();
      console.info("Media SQL queries (5 rows / 50 rows / 3338 assets):", smallCount, firstCount, queries.mock.calls.length);
    } finally { queries.mockRestore(); references.mockRestore(); }
  });

  it("offers eligible picker media while retaining an unavailable attached asset", async () => {
    const rows = [];
    for (const kind of ["IMAGE", "AUDIO"] as const) for (const status of ["READY", "EXTERNAL", "PROCESSING", "FAILED", "RETIRED"] as const) {
      if (kind === "IMAGE" && status === "EXTERNAL") continue;
      rows.push(await prisma.mediaAsset.create({ data: mediaFixture(kind, status) }));
    }
    const queries = vi.spyOn(DatabasePool.prototype, "query");
    try {
      const images = await listMediaOptions(viewer, "IMAGE");
      expect(queries).toHaveBeenCalledTimes(1); expect(images).toHaveLength(1); expect(images[0]!.status).toBe("READY");
      const audio = await listMediaOptions(viewer, "AUDIO");
      expect(audio.map(x => x.status).sort()).toEqual(["EXTERNAL", "READY"]);
      const retired = rows.find(x => x.kind === "IMAGE" && x.status === "RETIRED")!;
      const attached = await listMediaOptions(viewer, "IMAGE", retired.id);
      expect(attached.map(x => x.id)).toContain(retired.id); expect(attached).toHaveLength(2);
      expect((await listMediaOptions(viewer, "AUDIO", retired.id)).map(x => x.id)).not.toContain(retired.id);
      expect(attached.every(x => !("references" in x) && !("variants" in x) && !("referenceCount" in x))).toBe(true);
    } finally { queries.mockRestore(); }
  });
});
