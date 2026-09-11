import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { createArtist, getArtist, publishArtist, updateArtistDraft } from "@/modules/artists/service";
import { assertReadyArtwork, createAndProcessImage, getMediaReferences, purgeEligibleMedia, readMediaSource, retryImageProcessing } from "@/modules/media/service";
import type { StorageProvider } from "@/modules/media/storage";
import { runMediaProcessingJobs } from "@/modules/media/image-worker";
import { createPodcast, getPodcast, publishPodcast, updatePodcastDraft } from "@/modules/podcasts/service";
import { createRelease, getRelease, publishRelease, replaceReleaseTracks, updateReleaseDraft } from "@/modules/releases/service";
import { createTrack, getTrack, publishTrack, updateTrackDraft } from "@/modules/tracks/service";
import { GET as getLegacyMedia } from "@/app/assets/uploads/files/[...path]/route";
import { localStorage } from "@/modules/media/storage";

class MemoryStorage implements StorageProvider {
  constructor(readonly kind: "LOCAL" | "S3_COMPATIBLE" = "LOCAL") {}
  files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer) { if (this.files.has(key)) throw new Error("immutable collision"); this.files.set(key, bytes); }
  async read(key: string) { const value = this.files.get(key); if (!value) throw new Error("missing"); return value; }
  async exists(key: string) { return this.files.has(key); }
  async delete(key: string) { this.files.delete(key); }
}

let editor: Actor; let admin: Actor; let labelId: string; let image: Buffer;
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "media_audit_logs", "media_variants", "media_assets", "release_audit_logs", "release_revision_tracks", "release_revisions", "release_tracks", "releases", "podcast_audit_logs", "podcast_chapter_revisions", "podcast_episode_revisions", "podcast_chapters", "podcast_episodes", "track_audit_logs", "track_revisions", "tracks", "audit_logs", "artist_revisions", "artists", "accounts", "sessions", "verifications", "users", "labels" RESTART IDENTITY CASCADE');
  const editorUser = await prisma.user.create({ data: { name: "Editor", email: "media-editor@test.local", role: "EDITOR", emailVerified: true } }); const adminUser = await prisma.user.create({ data: { name: "Admin", email: "media-admin@test.local", role: "ADMIN", emailVerified: true } });
  editor = { userId: editorUser.id, role: "EDITOR" }; admin = { userId: adminUser.id, role: "ADMIN" }; labelId = (await prisma.label.create({ data: { name: "Steyoyoke", slug: "steyoyoke", legacyValue: "STEYOYOKE" } })).id;
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
    expect((await getMediaReferences(editor, a.id)).some(({ type }) => type.endsWith("REVISION"))).toBe(true);
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
