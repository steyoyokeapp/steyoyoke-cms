import { afterAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authorization";
import { applyLocalE2ECleanup, previewLocalE2ECleanup } from "@/lib/dev-cleanup";
import { prisma } from "@/lib/prisma";
import { createArtist, publishArtist } from "@/modules/artists/service";
import { createPodcast, publishPodcast } from "@/modules/podcasts/service";
import { createRelease, publishRelease, replaceReleaseTracks } from "@/modules/releases/service";
import { createTrack, publishTrack } from "@/modules/tracks/service";

afterAll(async () => prisma.$disconnect());

describe("local E2E cleanup", () => {
  it("removes complete marked catalogue graphs while preserving manual content, users, and ADMIN sessions", async () => {
    const stamp = String(Date.now()); const unique = crypto.randomUUID();
    const editorUser = await prisma.user.create({ data: { name: "Cleanup Editor", email: `cleanup-editor-${unique}@test.local`, role: "EDITOR", emailVerified: true } });
    const adminUser = await prisma.user.create({ data: { name: "Cleanup Owner", email: `cleanup-owner-${unique}@test.local`, role: "ADMIN", emailVerified: true } });
    const actor: Actor = { userId: editorUser.id, role: "EDITOR" };
    const label = await prisma.label.create({ data: { name: `Cleanup Label ${unique}`, slug: `cleanup-${unique}`, legacyValue: `CLEANUP-${unique}` } });
    const manual = await createArtist(actor, { name: `Legitimate Local Artist ${unique}` });
    const image = await prisma.mediaAsset.create({ data: { kind: "IMAGE", status: "READY", provider: "LOCAL", sourceStorageKey: `tests/${unique}/cover.png`, compatibilityFilename: `${unique}.png`, originalFilename: `podcast-${stamp}.png`, mimeType: "image/png", byteSize: 68, sha256Checksum: "a".repeat(64), width: 1, height: 1, createdById: editorUser.id } });
    const audio = await prisma.mediaAsset.create({ data: { kind: "AUDIO", status: "READY", provider: "LOCAL", sourceStorageKey: `tests/${unique}/audio.mp3`, legacyAudioId: crypto.randomUUID(), originalFilename: `podcast-${stamp}.mp3`, mimeType: "audio/mpeg", byteSize: 100, sha256Checksum: "b".repeat(64), durationMs: 1_000, createdById: editorUser.id } });
    const artist = await createArtist(actor, { name: `Audio E2E Artist ${stamp}`, imageAssetId: image.id }); await publishArtist(actor, artist.id, { expectedWorkingVersion: 1 });
    const track = await createTrack(actor, { title: `Audio Track ${stamp}`, primaryArtistId: artist.id, labelId: label.id, artworkAssetId: image.id, audioAssetId: audio.id }); await publishTrack(actor, track.id, { expectedWorkingVersion: 1 });
    const podcast = await createPodcast(actor, { title: `Audio Podcast ${stamp}`, primaryArtistId: artist.id, labelId: label.id, episodeDate: "2026-09-11", artworkAssetId: image.id, audioAssetId: audio.id }); await publishPodcast(actor, podcast.id, { expectedWorkingVersion: 1 });
    const release = await createRelease(actor, { title: `Steyoyoke Release E2E ${stamp}`, primaryArtistId: artist.id, labelId: label.id, releaseDate: "2026-09-11", artworkAssetId: image.id }); await replaceReleaseTracks(actor, release.id, { expectedWorkingVersion: 1, trackIds: [track.id] }); await publishRelease(actor, release.id, { expectedWorkingVersion: 2 });
    await prisma.session.createMany({ data: [{ token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000), userAgent: "Playwright HeadlessChrome", userId: editorUser.id }, { token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000), userAgent: "Playwright HeadlessChrome", userId: adminUser.id }] });

    try {
      const preview = await previewLocalE2ECleanup();
      expect(preview).toMatchObject({ artists: 1, tracks: 1, podcasts: 1, releases: 1, mediaAssets: 2, automatedNonAdminSessions: 1, protectedMediaAssets: 0, protectedCatalogueRecords: 0 });
      expect(preview.artistRevisions).toBeGreaterThan(0); expect(preview.trackRevisions).toBeGreaterThan(0); expect(preview.podcastRevisions).toBeGreaterThan(0); expect(preview.releaseRevisions).toBeGreaterThan(0);
      await applyLocalE2ECleanup();
      expect(await prisma.artist.findUnique({ where: { id: manual.id } })).not.toBeNull();
      expect(await prisma.artist.findUnique({ where: { id: artist.id } })).toBeNull(); expect(await prisma.track.findUnique({ where: { id: track.id } })).toBeNull();
      expect(await prisma.podcastEpisode.findUnique({ where: { id: podcast.id } })).toBeNull(); expect(await prisma.release.findUnique({ where: { id: release.id } })).toBeNull();
      expect(await prisma.mediaAsset.count({ where: { id: { in: [image.id, audio.id] } } })).toBe(0);
      expect(await prisma.session.count({ where: { userId: editorUser.id } })).toBe(0); expect(await prisma.session.count({ where: { userId: adminUser.id } })).toBe(1);
      expect(await prisma.user.count({ where: { id: { in: [editorUser.id, adminUser.id] } } })).toBe(2);
    } finally {
      await applyLocalE2ECleanup().catch(() => undefined); await prisma.auditLog.deleteMany({ where: { artistId: manual.id } }); await prisma.artist.deleteMany({ where: { id: manual.id } });
      await prisma.session.deleteMany({ where: { userId: { in: [editorUser.id, adminUser.id] } } }); await prisma.user.deleteMany({ where: { id: { in: [editorUser.id, adminUser.id] } } }); await prisma.label.deleteMany({ where: { id: label.id } });
    }
  });

  it("protects a test-marked artist referenced by legitimate local content", async () => {
    const stamp = String(Date.now()); const unique = crypto.randomUUID();
    const user = await prisma.user.create({ data: { name: "Cleanup Reference Owner", email: `cleanup-reference-${unique}@test.local`, role: "EDITOR", emailVerified: true } });
    const actor: Actor = { userId: user.id, role: "EDITOR" };
    const label = await prisma.label.create({ data: { name: `Cleanup Reference Label ${unique}`, slug: `cleanup-reference-${unique}`, legacyValue: `CLEANUP-REFERENCE-${unique}` } });
    const artist = await createArtist(actor, { name: `Track E2E Artist ${stamp}` });
    const track = await createTrack(actor, { title: `Legitimate Local Track ${unique}`, primaryArtistId: artist.id, labelId: label.id });

    try {
      expect(await previewLocalE2ECleanup()).toMatchObject({ artists: 0, protectedCatalogueRecords: 1 });
      await applyLocalE2ECleanup();
      expect(await prisma.artist.findUnique({ where: { id: artist.id } })).not.toBeNull();
      expect(await prisma.track.findUnique({ where: { id: track.id } })).not.toBeNull();
    } finally {
      await prisma.trackAuditLog.deleteMany({ where: { trackId: track.id } });
      await prisma.track.deleteMany({ where: { id: track.id } });
      await prisma.auditLog.deleteMany({ where: { artistId: artist.id } });
      await prisma.artist.deleteMany({ where: { id: artist.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
      await prisma.label.deleteMany({ where: { id: label.id } });
    }
  });
});
