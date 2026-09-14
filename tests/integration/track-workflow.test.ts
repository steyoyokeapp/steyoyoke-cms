import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTrack, archiveTrack, updateTrackDraft, publishTrack } from "@/modules/tracks/service";
import { replaceReleaseTracks, scheduleRelease, cancelReleaseSchedule } from "@/modules/releases/service";
import { publishArtist } from "@/modules/artists/service";
import { cataloguePage } from "@/modules/catalogue/reads";
import type { Actor } from "@/lib/authorization";
let actor: Actor; let artistId: string; let labelId: string;
beforeEach(async () => {
  const url = new URL(process.env.DATABASE_URL!); if (url.hostname !== "127.0.0.1" || !url.pathname.endsWith("_test")) throw new Error("Isolated local test database required");
  await prisma.$executeRawUnsafe('TRUNCATE users, artists, labels, tracks, releases, media_assets CASCADE');
  actor = { userId: (await prisma.user.create({ data: { name: "Test", email: "track-flow@test.local", role: "ADMIN" } })).id, role: "ADMIN" };
  artistId = (await prisma.artist.create({ data: { id: crypto.randomUUID(), name: "Test Artist", slug: "test-artist" } })).id;
  labelId = (await prisma.label.create({ data: { name: "Test Label", slug: "test-label", legacyValue: "TEST" } })).id;
});
afterAll(() => prisma.$disconnect());
it("preserves hidden SoundCloud and historical duration on ordinary edits", async () => {
  const track = await createTrack(actor, { title: "Before", primaryArtistId: artistId, labelId, soundcloudUrl: "https://soundcloud.com/old", durationMs: 321000 });
  const updated = await updateTrackDraft(actor, track.id, { title: "After", primaryArtistId: artistId, labelId, expectedWorkingVersion: 1 });
  expect(updated.soundcloudUrl).toBe("https://soundcloud.com/old"); expect(updated.durationMs).toBe(321000);
});
it("preserves attached audio and derives replacement duration on the server", async () => {
  const audio=await prisma.mediaAsset.create({data:{kind:'AUDIO',status:'READY',sourceStorageKey:'audio/test-original/source.mp3',originalFilename:'test-original.mp3',mimeType:'audio/mpeg',byteSize:100,sha256Checksum:'a'.repeat(64),legacyAudioId:'test_original_audio',durationMs:247000,createdById:actor.userId}});
  const replacement=await prisma.mediaAsset.create({data:{kind:'AUDIO',status:'READY',sourceStorageKey:'audio/test-replacement/source.mp3',originalFilename:'test-replacement.mp3',mimeType:'audio/mpeg',byteSize:100,sha256Checksum:'b'.repeat(64),legacyAudioId:'test_replacement_audio',durationMs:311000,createdById:actor.userId}});
  const track=await createTrack(actor,{title:'Audio preserved',primaryArtistId:artistId,labelId,audioAssetId:audio.id,durationMs:1});
  expect(track.durationMs).toBe(247000);
  const edit=await updateTrackDraft(actor,track.id,{title:'Title only',primaryArtistId:artistId,labelId,expectedWorkingVersion:1});
  expect(edit.audioAssetId).toBe(audio.id);expect(edit.durationMs).toBe(247000);
  const replaced=await updateTrackDraft(actor,track.id,{title:'Replacement',primaryArtistId:artistId,labelId,audioAssetId:replacement.id,durationMs:1,expectedWorkingVersion:2});
  expect(replaced.audioAssetId).toBe(replacement.id);expect(replaced.durationMs).toBe(311000);
  expect(await prisma.mediaAsset.findUnique({where:{id:audio.id}})).not.toBeNull();
});
it("operationally deletes a draft while preserving its audit and excluding default lists", async () => {
  const track = await createTrack(actor, { title: "Delete", primaryArtistId: artistId, labelId });
  await archiveTrack(actor, track.id);
  expect(await prisma.track.findUnique({ where: { id: track.id } })).toMatchObject({ status: "ARCHIVED" });
  expect(await prisma.trackAuditLog.count({ where: { trackId: track.id } })).toBe(2);
  expect(JSON.stringify(await cataloguePage(actor, "tracks"))).not.toContain(track.id);
  expect(JSON.stringify(await cataloguePage(actor, "tracks", { status: "ARCHIVED" }))).toContain(track.id);
});
it("blocks working Release dependencies and rejects new archived attachments", async () => {
  const track = await createTrack(actor, { title: "Attached", primaryArtistId: artistId, labelId });
  const release = await prisma.release.create({ data: { id: crypto.randomUUID(), title: "Working release", primaryArtistId: artistId, labelId } });
  await replaceReleaseTracks(actor, release.id, { trackIds: [track.id], expectedWorkingVersion: 1 });
  await expect(archiveTrack(actor, track.id)).rejects.toMatchObject({ code: "TRACK_RELEASE_DEPENDENCY" });
  await replaceReleaseTracks(actor, release.id, { trackIds: [], expectedWorkingVersion: 2 });
  await archiveTrack(actor, track.id);
  await expect(replaceReleaseTracks(actor, release.id, { trackIds: [track.id], expectedWorkingVersion: 3 })).rejects.toMatchObject({ code: "TRACK_ARCHIVED" });
});
it("enforces server permissions", async () => {
  const track = await createTrack(actor, { title: "Protected", primaryArtistId: artistId, labelId });
  await expect(archiveTrack({ ...actor, role: "VIEWER" }, track.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("protects a scheduled snapshot after its Track is removed from the working Release", async () => {
  await publishArtist(actor,artistId,{expectedWorkingVersion:1});
  const track=await createTrack(actor,{title:'Scheduled dependency',primaryArtistId:artistId,labelId});
  await publishTrack(actor,track.id,{expectedWorkingVersion:1});
  const artwork=await prisma.mediaAsset.create({data:{kind:'IMAGE',status:'READY',sourceStorageKey:'tests/scheduled-release.jpg',compatibilityFilename:'scheduled-release.jpg',originalFilename:'test.jpg',mimeType:'image/jpeg',byteSize:3,sha256Checksum:'a'.repeat(64),width:1,height:1,createdById:actor.userId}});
  const release=await prisma.release.create({data:{title:'Scheduled release',primaryArtistId:artistId,labelId,releaseDate:new Date('2026-09-14'),artworkAssetId:artwork.id}});
  await replaceReleaseTracks(actor,release.id,{trackIds:[track.id],expectedWorkingVersion:1});
  await scheduleRelease(actor,release.id,{expectedWorkingVersion:2,scheduledFor:new Date(Date.now()+3600000)});
  await replaceReleaseTracks(actor,release.id,{trackIds:[],expectedWorkingVersion:2});
  await expect(archiveTrack(actor,track.id)).rejects.toMatchObject({code:'TRACK_RELEASE_DEPENDENCY'});
  await cancelReleaseSchedule(actor,release.id);
  await archiveTrack(actor,track.id);
  expect(await prisma.releaseRevisionTrack.count({where:{trackRevision:{trackId:track.id}}})).toBe(1);
});
