import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { createArtist, getArtist, publishArtist, updateArtistDraft } from "@/modules/artists/service";
import { createAndProcessImage, getMediaReferences, purgeEligibleMedia } from "@/modules/media/service";
import type { StorageProvider } from "@/modules/media/storage";
import { createPodcast, getPodcast, publishPodcast, updatePodcastDraft } from "@/modules/podcasts/service";
import { createRelease, getRelease, publishRelease, replaceReleaseTracks, updateReleaseDraft } from "@/modules/releases/service";
import { createTrack, getTrack, publishTrack, updateTrackDraft } from "@/modules/tracks/service";
import { GET as getLegacyMedia } from "@/app/assets/uploads/files/[...path]/route";
import { localStorage, S3StorageProvider } from "@/modules/media/storage";

class MemoryStorage implements StorageProvider {
  readonly kind = "LOCAL" as const;
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

async function media(storage = new MemoryStorage(), name = "artwork.jpg") { return createAndProcessImage(editor, { name, bytes: image }, storage); }

describe("media service and frozen artwork references", () => {
  it("creates immutable READY metadata, six variants, checksums, safe keys, and one upload audit", async () => {
    const storage = new MemoryStorage(); const asset = await media(storage, "../user supplied name.jpg");
    expect(asset.status).toBe("READY"); expect(asset.variants).toHaveLength(6); expect(asset.compatibilityFilename).toMatch(/^[0-9a-f-]+\.jpg$/); expect(asset.sourceStorageKey).toMatch(/^images\/[0-9a-f-]+\/source\.jpg$/);
    expect(asset.variants.find(({ variantKey }) => variantKey === "LEGACY_1440")).toMatchObject({ width: 400, height: 500 }); expect(asset.variants.find(({ variantKey }) => variantKey === "LEGACY_THUMB_80")).toMatchObject({ width: 64, height: 80 }); expect(storage.files.size).toBe(7);
    expect(await prisma.mediaAuditLog.count({ where: { mediaAssetId: asset.id, action: "MEDIA_UPLOAD" } })).toBe(1);
    await expect(prisma.mediaAsset.update({ where: { id: asset.id }, data: { sha256Checksum: "b".repeat(64) } })).rejects.toThrow(/immutable/); await expect(prisma.mediaVariant.update({ where: { id: asset.variants[0]!.id }, data: { width: 9 } })).rejects.toThrow(/immutable/);
  });

  it("emits one safe structured profile event for an S3-compatible image upload", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const storage = new S3StorageProvider({ bucket: "profile-test", region: "test", client: { send: async () => ({}) } as never });
    await createAndProcessImage(editor, { name: "private-filename.jpg", bytes: image }, storage, { requestId: "iad1::profile-test", parseMs: 1.25 });
    const profiles = output.mock.calls.map(([line]) => JSON.parse(String(line))).filter(({ event }) => event === "media_image_upload_profile");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ requestId: "iad1::profile-test", operation: "image upload", storageProvider: "S3_COMPATIBLE", parseMs: 1.25, variantCount: 6, inputByteSize: image.length, inputWidth: 400, inputHeight: 500 });
    for (const field of ["totalMs", "dbCreateMs", "imageProcessingMs", "metadataMs", "variantProcessingMs", "storageWriteMs", "s3WriteMs", "sourceWriteMs", "dbVariantWriteMs", "finalizeMs", "variantProcessingMs_ORIGINAL", "variantStorageWriteMs_ORIGINAL"]) expect(profiles[0][field]).toEqual(expect.any(Number));
    expect(JSON.stringify(profiles[0])).not.toContain("private-filename.jpg");
    output.mockRestore();
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
    expect(await prisma.mediaAsset.findFirst()).toMatchObject({ status: "FAILED", failureReason: "Image processing or local storage failed." });
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
    const asset = await createAndProcessImage(editor, { name: "route.jpg", bytes: image });
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
