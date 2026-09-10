import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { archiveArtist, createArtist, publishArtist } from "@/modules/artists/service";
import { handleLegacyReleaseRequest } from "@/modules/releases/legacy";
import { archiveRelease, cancelReleaseSchedule, createRelease, getLegacyReleaseCompletePreview, getLegacyReleasePreview, getRelease, getReleasePreview, publishRelease, reorderReleaseTracks, replaceReleaseTracks, restoreRelease, runScheduledReleasePublication, scheduleRelease, unpublishRelease, updateReleaseDraft } from "@/modules/releases/service";
import { createTrack, publishTrack, updateTrackDraft } from "@/modules/tracks/service";

let editor: Actor; let viewer: Actor; let labelId: string; let artworkAssetId: string;
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "media_audit_logs", "media_variants", "media_assets", "release_audit_logs", "release_revision_tracks", "release_revisions", "release_tracks", "releases", "podcast_audit_logs", "podcast_chapter_revisions", "podcast_episode_revisions", "podcast_chapters", "podcast_episodes", "track_audit_logs", "track_revisions", "tracks", "audit_logs", "artist_revisions", "artists", "accounts", "sessions", "verifications", "users", "labels" RESTART IDENTITY CASCADE');
  const [editorUser, viewerUser] = await Promise.all([prisma.user.create({ data: { name: "Editor", email: "release-editor@test.local", role: "EDITOR", emailVerified: true } }), prisma.user.create({ data: { name: "Viewer", email: "release-viewer@test.local", role: "VIEWER", emailVerified: true } })]);
  editor = { userId: editorUser.id, role: "EDITOR" }; viewer = { userId: viewerUser.id, role: "VIEWER" };
  artworkAssetId = (await prisma.mediaAsset.create({ data: { kind: "IMAGE", status: "READY", provider: "LOCAL", sourceStorageKey: `tests/${crypto.randomUUID()}.jpg`, compatibilityFilename: `${crypto.randomUUID()}.jpg`, originalFilename: "test.jpg", mimeType: "image/jpeg", byteSize: 3, sha256Checksum: "a".repeat(64), width: 1, height: 1, createdById: editor.userId } })).id;
  labelId = (await prisma.label.create({ data: { name: "Steyoyoke Black", slug: "steyoyoke-black", legacyValue: "STEYOYOKE_BLACK" } })).id;
});
afterAll(async () => prisma.$disconnect());

async function artist(name = "Release Artist", publish = true) { const value = await createArtist(editor, { name }); if (publish) await publishArtist(editor, value.id, { expectedWorkingVersion: 1 }); return value; }
async function track(primaryArtistId: string, title: string, publish = true) { const value = await createTrack(editor, { title, primaryArtistId, labelId, durationMs: 225000 }); if (publish) await publishTrack(editor, value.id, { expectedWorkingVersion: 1 }); return value; }
async function release(primaryArtistId: string, title = "Steyoyoke Release One", secondaryArtistId?: string) { return createRelease(editor, { title, primaryArtistId, secondaryArtistId, labelId, releaseDate: "2026-07-08", bandcampUrl: "https://example.test/release", artworkAssetId }); }
const request = (filter: string, legacyId?: number, query = "") => new Request(`http://local/index.php/cms/api${legacyId === undefined ? "" : `/${legacyId}`}?filter=${filter}${query}`, { headers: { "X-Csrf-Token": process.env.LEGACY_API_KEY_A! } });

describe("Release publication service", () => {
  it("allocates stable Release legacy IDs from 649 and enforces immutability", async () => {
    const primary = await artist(); const first = await release(primary.id); const second = await release(primary.id, "Second Release");
    expect([first.legacyId, second.legacyId]).toEqual([649, 650]);
    const defaults = await prisma.$queryRaw<Array<{ value: string }>>`SELECT column_default AS value FROM information_schema.columns WHERE table_name = 'releases' AND column_name = 'legacyId'`;
    expect(defaults[0]?.value).toContain("legacy_release_id_seq"); await expect(prisma.release.update({ where: { id: first.id }, data: { legacyId: 9999 } })).rejects.toThrow(/immutable/);
  });

  it("atomically replaces and reorders unique Track membership", async () => {
    const primary = await artist(); const [a, b] = await Promise.all([track(primary.id, "Track A"), track(primary.id, "Track B")]); const value = await release(primary.id);
    const memberships = await replaceReleaseTracks(editor, value.id, { expectedWorkingVersion: 1, trackIds: [a.id, b.id] }); expect(memberships.map(({ position }) => position)).toEqual([0, 1]);
    const reordered = await reorderReleaseTracks(editor, value.id, { expectedWorkingVersion: 2, trackIds: [b.id, a.id] }); expect(reordered.map(({ trackId }) => trackId)).toEqual([b.id, a.id]); expect((await getRelease(editor, value.id)).workingVersion).toBe(3);
    await expect(replaceReleaseTracks(editor, value.id, { expectedWorkingVersion: 3, trackIds: [a.id, a.id] })).rejects.toMatchObject({ code: "DUPLICATE_RELEASE_TRACK" }); await expect(reorderReleaseTracks(editor, value.id, { expectedWorkingVersion: 3, trackIds: [a.id] })).rejects.toMatchObject({ code: "REORDER_MEMBERSHIP_CHANGED" });
  });

  it("rejects missing publication dependencies and Viewer writes", async () => {
    const draftArtist = await artist("Draft Artist", false); const value = await release(draftArtist.id); await expect(publishRelease(editor, value.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "PRIMARY_ARTIST_NOT_PUBLISHABLE" });
    const primary = await artist("Published Artist"); const empty = await release(primary.id, "No Tracks"); await expect(publishRelease(editor, empty.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "RELEASE_TRACKS_REQUIRED" });
    const draftTrack = await track(primary.id, "Draft Track", false); await replaceReleaseTracks(editor, empty.id, { expectedWorkingVersion: 1, trackIds: [draftTrack.id] }); await expect(publishRelease(editor, empty.id, { expectedWorkingVersion: 2 })).rejects.toMatchObject({ code: "TRACK_NOT_PUBLISHABLE" });
    await archiveArtist(editor, primary.id); const archivedArtistRelease = await release(primary.id, "Archived dependency"); await expect(publishRelease(editor, archivedArtistRelease.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "PRIMARY_ARTIST_NOT_PUBLISHABLE" });
    await expect(createRelease(viewer, { title: "Denied", primaryArtistId: primary.id, labelId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("isolates drafts and freezes the exact TrackRevision until Release republish", async () => {
    const primary = await artist(); const [a, b] = await Promise.all([track(primary.id, "Track A r1"), track(primary.id, "Track B r1")]); const value = await release(primary.id); await replaceReleaseTracks(editor, value.id, { expectedWorkingVersion: 1, trackIds: [a.id, b.id] });
    expect((await (await handleLegacyReleaseRequest(request("releases", value.legacyId), value.legacyId)).json()).releases).toEqual([]); await publishRelease(editor, value.id, { expectedWorkingVersion: 2 });
    await updateReleaseDraft(editor, value.id, { title: "Draft Release Title", primaryArtistId: primary.id, secondaryArtistId: "", labelId, releaseDate: "2026-07-09", expectedWorkingVersion: 2 }); await reorderReleaseTracks(editor, value.id, { expectedWorkingVersion: 3, trackIds: [b.id, a.id] });
    await updateTrackDraft(editor, a.id, { title: "Track A r2", primaryArtistId: primary.id, secondaryArtistId: "", labelId, durationMs: 225000, expectedWorkingVersion: 1 }); await publishTrack(editor, a.id, { expectedWorkingVersion: 2 });
    let complete = await (await handleLegacyReleaseRequest(request("releasecomplete", value.legacyId), value.legacyId)).json(); expect(complete.releasecomplete["0"].title).toBe("Release One"); expect(complete.releasecomplete.tracks.map((item: { title: string }) => item.title)).toEqual(["Track A r1", "Track B r1"]);
    expect((await getReleasePreview(editor, value.id)).tracks.find(({ id }) => id === a.id)?.changedSinceReleasePublication).toBe(true);
    expect((await getLegacyReleasePreview(editor, value.id)).releases[0]?.title).toBe("Draft Release Title"); expect((await getLegacyReleaseCompletePreview(editor, value.id)).releasecomplete.tracks.map((item: { title: string }) => item.title)).toEqual(["Track B r1", "Track A r2"]);
    await publishRelease(editor, value.id, { expectedWorkingVersion: 4 }); complete = await (await handleLegacyReleaseRequest(request("releasecomplete", value.legacyId), value.legacyId)).json(); expect(complete.releasecomplete["0"].title).toBe("Draft Release Title"); expect(complete.releasecomplete.tracks.map((item: { title: string }) => item.title)).toEqual(["Track B r1", "Track A r2"]);
    const detail = await getRelease(editor, value.id); expect(detail.revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([2, 1]); await expect(prisma.releaseRevision.update({ where: { id: detail.revisions[0]!.id }, data: { title: "Tampered" } })).rejects.toThrow(/immutable/); await expect(prisma.releaseRevisionTrack.update({ where: { id: detail.revisions[0]!.tracks[0]!.id }, data: { position: 99 } })).rejects.toThrow(/immutable/);
  });

  it("freezes scheduled metadata/order and exact Track revisions", async () => {
    const primary = await artist(); const [a, b] = await Promise.all([track(primary.id, "Scheduled A r1"), track(primary.id, "Scheduled B r1")]); const value = await release(primary.id, "Scheduled Release"); await replaceReleaseTracks(editor, value.id, { expectedWorkingVersion: 1, trackIds: [a.id, b.id] }); const future = new Date(Date.now() + 3600000);
    await scheduleRelease(editor, value.id, { expectedWorkingVersion: 2, scheduledFor: future }); await cancelReleaseSchedule(editor, value.id); await scheduleRelease(editor, value.id, { expectedWorkingVersion: 2, scheduledFor: future });
    await updateReleaseDraft(editor, value.id, { title: "Later working title", primaryArtistId: primary.id, secondaryArtistId: "", labelId, releaseDate: "2026-07-10", expectedWorkingVersion: 2 }); await updateTrackDraft(editor, a.id, { title: "Scheduled A r2", primaryArtistId: primary.id, secondaryArtistId: "", labelId, durationMs: 225000, expectedWorkingVersion: 1 }); await publishTrack(editor, a.id, { expectedWorkingVersion: 2 });
    expect(await runScheduledReleasePublication(new Date(future.getTime() - 1))).toEqual({ examined: 0, published: 0 }); expect(await runScheduledReleasePublication(future)).toEqual({ examined: 1, published: 1 });
    const detail = await getRelease(editor, value.id); expect(detail.publishedRevision?.title).toBe("Scheduled Release"); expect(detail.publishedRevision?.tracks.map(({ trackRevision }) => trackRevision.title)).toEqual(["Scheduled A r1", "Scheduled B r1"]);
  });

  it("unpublishes and restores without accidental republication", async () => {
    const primary = await artist(); const a = await track(primary.id, "Lifecycle Track"); const value = await release(primary.id); await replaceReleaseTracks(editor, value.id, { expectedWorkingVersion: 1, trackIds: [a.id] }); await publishRelease(editor, value.id, { expectedWorkingVersion: 2 }); await unpublishRelease(editor, value.id); await archiveRelease(editor, value.id); await restoreRelease(editor, value.id);
    expect((await getRelease(editor, value.id)).status).toBe("UNPUBLISHED"); expect((await (await handleLegacyReleaseRequest(request("releases", value.legacyId), value.legacyId)).json()).releases).toEqual([]);
  });

  it("preserves legacy modes, releasecomplete, releasefilter mismatch, and lookups", async () => {
    const primary = await artist("API Primary"); const secondary = await artist("API Secondary"); const [matching, other] = await Promise.all([track(primary.id, "Needle Track"), track(primary.id, "Other Track")]);
    const first = await release(primary.id, "Steyoyoke Alpha Release", secondary.id); await replaceReleaseTracks(editor, first.id, { expectedWorkingVersion: 1, trackIds: [matching.id, other.id] }); await publishRelease(editor, first.id, { expectedWorkingVersion: 2 });
    const second = await release(primary.id, "Beta Release"); await replaceReleaseTracks(editor, second.id, { expectedWorkingVersion: 1, trackIds: [other.id] }); await publishRelease(editor, second.id, { expectedWorkingVersion: 2 });
    const paginated = await (await handleLegacyReleaseRequest(request("releases", undefined, "&limit=10&offset=0"))).json(); expect(paginated).toMatchObject({ total_rows: 2, limit: "10", offset: "0" }); expect(paginated.releases.find((item: { id: string }) => item.id === String(first.legacyId))).toMatchObject({ title: "Alpha Release", artist_name: "API Primary", secondary_artist_name: "API Secondary", label: "STEYOYOKE BLACK" });
    const unpaginated = await (await handleLegacyReleaseRequest(request("releases"))).json(); expect(unpaginated.releases[0]).toHaveProperty("artist_name"); expect(unpaginated.releases[0]).not.toHaveProperty("secondary_artist_name");
    const single = await (await handleLegacyReleaseRequest(request("releases", first.legacyId), first.legacyId)).json(); expect(single.releases[0]).not.toHaveProperty("artist_name");
    const complete = await (await handleLegacyReleaseRequest(request("releasecomplete", first.legacyId), first.legacyId)).json(); expect(Object.keys(complete.releasecomplete)).toEqual(["0", "tracks"]); expect(complete.releasecomplete.tracks.map((item: { title: string }) => item.title)).toEqual(["Needle Track", "Other Track"]); expect(complete.releasecomplete.tracks[0]).toMatchObject({ artist_track_name: "API Primary", secondary_artist_track_name: null });
    const filtered = await (await handleLegacyReleaseRequest(request("releasefilter", undefined, "&artist=API&tracktl=Needle&limit=10&offset=0"))).json(); expect(filtered.total_rows).toBe(2); expect(filtered.releasefilter).toHaveLength(1); expect(filtered.releasefilter[0].title_track).toEqual([{ track_title: "Needle Track", id: String(first.legacyId) }]);
    expect((await (await handleLegacyReleaseRequest(request("allreleaseartist"))).json()).allreleaseartist).toEqual([{ artist_name: "API Primary" }]); expect((await (await handleLegacyReleaseRequest(request("alltitlerelease"))).json()).alltitlerelease.map((item: { release_title: string }) => item.release_title)).toEqual(["Beta Release", "Steyoyoke Alpha Release"]); expect((await (await handleLegacyReleaseRequest(request("alltitletrackrelease"))).json()).alltitletrackrelease).toEqual([{ track_title: "Needle Track" }, { track_title: "Other Track" }]);
  });
});
