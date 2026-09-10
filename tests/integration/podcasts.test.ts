import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { archiveArtist, createArtist, publishArtist } from "@/modules/artists/service";
import { handleLegacyPodcastRequest } from "@/modules/podcasts/legacy";
import { archivePodcast, cancelPodcastSchedule, createPodcast, getPodcast, getPublishedPodcastForLegacy, publishPodcast, replacePodcastChapters, restorePodcast, runScheduledPodcastPublication, schedulePodcast, unpublishPodcast, updatePodcastDraft } from "@/modules/podcasts/service";
import { createTrack, publishTrack } from "@/modules/tracks/service";
import { handleLegacyTrackRequest } from "@/modules/tracks/legacy";

let editor: Actor; let viewer: Actor; let labelId: string; let artworkAssetId: string; let audioAssetId: string;
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "media_audit_logs", "media_variants", "media_assets", "podcast_audit_logs", "podcast_chapter_revisions", "podcast_episode_revisions", "podcast_chapters", "podcast_episodes", "track_audit_logs", "track_revisions", "tracks", "audit_logs", "artist_revisions", "artists", "accounts", "sessions", "verifications", "users", "labels" RESTART IDENTITY CASCADE');
  const [editorUser, viewerUser] = await Promise.all([prisma.user.create({ data: { name: "Editor", email: "podcast-editor@test.local", role: "EDITOR", emailVerified: true } }), prisma.user.create({ data: { name: "Viewer", email: "podcast-viewer@test.local", role: "VIEWER", emailVerified: true } })]);
  editor = { userId: editorUser.id, role: "EDITOR" }; viewer = { userId: viewerUser.id, role: "VIEWER" };
  artworkAssetId = (await prisma.mediaAsset.create({ data: { kind: "IMAGE", status: "READY", provider: "LOCAL", sourceStorageKey: `tests/${crypto.randomUUID()}.jpg`, compatibilityFilename: `${crypto.randomUUID()}.jpg`, originalFilename: "test.jpg", mimeType: "image/jpeg", byteSize: 3, sha256Checksum: "a".repeat(64), width: 1, height: 1, createdById: editor.userId } })).id;
  audioAssetId = (await prisma.mediaAsset.create({ data: { kind: "AUDIO", status: "READY", provider: "LOCAL", sourceStorageKey: `tests/${crypto.randomUUID()}.mp3`, legacyAudioId: crypto.randomUUID(), originalFilename: "test.mp3", mimeType: "audio/mpeg", byteSize: 3, sha256Checksum: "b".repeat(64), durationMs: 1000, createdById: editor.userId } })).id;
  labelId = (await prisma.label.create({ data: { name: "Steyoyoke Black", slug: "steyoyoke-black", legacyValue: "STEYOYOKE_BLACK" } })).id;
});
afterAll(async () => prisma.$disconnect());
async function artist(name = "Podcast Artist", publish = true) { const value = await createArtist(editor, { name }); if (publish) await publishArtist(editor, value.id, { expectedWorkingVersion: 1 }); return value; }
async function podcast(primaryArtistId: string, title = "Steyoyoke Episode") { return createPodcast(editor, { title, primaryArtistId, labelId, episodeDate: "2026-08-09", durationMs: 3600000, artworkAssetId, audioAssetId }); }
const chapterInput = [{ artist: "Artist One", title: "First", legacyReference: "REF-1", durationMs: 225000 }, { artist: "Artist Two", title: "Second", legacyReference: null, durationMs: null }];
const request = (type: "track" | "podcast", legacyId?: number, query = "") => new Request(`http://local/index.php/cms/api${legacyId === undefined ? "" : `/${legacyId}`}?filter=tracks&type=${type}${query}`, { headers: { "X-Csrf-Token": process.env.LEGACY_API_KEY_A! } });

describe("Podcast publication service", () => {
  it("interleaves Track and Podcast IDs through legacy_track_id_seq", async () => {
    const primary = await artist(); const trackOne = await createTrack(editor, { title: "Track One", primaryArtistId: primary.id, labelId }); const episode = await podcast(primary.id); const trackTwo = await createTrack(editor, { title: "Track Two", primaryArtistId: primary.id, labelId });
    expect([trackOne.legacyId, episode.legacyId, trackTwo.legacyId]).toEqual([3337, 3338, 3339]);
    const defaults = await prisma.$queryRaw<Array<{ value: string }>>`SELECT column_default AS value FROM information_schema.columns WHERE table_name = 'podcast_episodes' AND column_name = 'legacyId'`;
    expect(defaults[0]?.value).toContain("legacy_track_id_seq"); await expect(prisma.podcastEpisode.update({ where: { id: episode.id }, data: { legacyId: 9999 } })).rejects.toThrow(/immutable/);
  });

  it("atomically replaces and normalizes structured chapters", async () => {
    const primary = await artist(); const episode = await podcast(primary.id); const saved = await replacePodcastChapters(editor, episode.id, { expectedWorkingVersion: 1, chapters: [{ ...chapterInput[0], position: 20 }, { ...chapterInput[1], position: 8 }] });
    expect(saved.map(({ position }) => position)).toEqual([0, 1]); expect((await getPodcast(editor, episode.id)).workingVersion).toBe(2);
    await expect(replacePodcastChapters(editor, episode.id, { expectedWorkingVersion: 1, chapters: [] })).rejects.toMatchObject({ code: "WORKING_VERSION_CONFLICT" }); expect((await getPodcast(editor, episode.id)).chapters).toHaveLength(2);
  });

  it("isolates working core/chapter edits and publishes revision 2 atomically", async () => {
    const primary = await artist(); const episode = await podcast(primary.id); await replacePodcastChapters(editor, episode.id, { expectedWorkingVersion: 1, chapters: chapterInput }); await publishPodcast(editor, episode.id, { expectedWorkingVersion: 2 });
    await updatePodcastDraft(editor, episode.id, { title: "Draft Episode", primaryArtistId: primary.id, secondaryArtistId: "", labelId, episodeDate: "2026-08-10", durationMs: 3600000, expectedWorkingVersion: 2 });
    await replacePodcastChapters(editor, episode.id, { expectedWorkingVersion: 3, chapters: [{ ...chapterInput[1], title: "Second edited" }, chapterInput[0]] });
    let delivered = await getPublishedPodcastForLegacy(episode.legacyId); expect(delivered?.publishedRevision?.title).toBe("Steyoyoke Episode"); expect(delivered?.publishedRevision?.chapters.map(({ title }) => title)).toEqual(["First", "Second"]);
    await publishPodcast(editor, episode.id, { expectedWorkingVersion: 4 }); delivered = await getPublishedPodcastForLegacy(episode.legacyId); expect(delivered?.publishedRevision?.title).toBe("Draft Episode"); expect(delivered?.publishedRevision?.chapters.map(({ title }) => title)).toEqual(["Second edited", "First"]);
    const detail = await getPodcast(editor, episode.id); expect(detail.revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([2, 1]);
    await expect(prisma.podcastEpisodeRevision.update({ where: { id: detail.revisions[0]!.id }, data: { title: "Tampered" } })).rejects.toThrow(/immutable/); await expect(prisma.podcastChapterRevision.update({ where: { id: detail.revisions[0]!.chapters[0]!.id }, data: { title: "Tampered" } })).rejects.toThrow(/immutable/);
  });

  it("validates date, Artists, Labels, and Viewer writes", async () => {
    const unpublished = await artist("Draft Artist", false); const noDate = await createPodcast(editor, { title: "No date", primaryArtistId: unpublished.id, labelId }); await expect(publishPodcast(editor, noDate.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "PRIMARY_ARTIST_NOT_PUBLISHABLE" });
    const archived = await artist("Archived"); await archiveArtist(editor, archived.id); const archivedEpisode = await podcast(archived.id); await expect(publishPodcast(editor, archivedEpisode.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "PRIMARY_ARTIST_NOT_PUBLISHABLE" });
    const active = await artist("Active"); const missingDate = await createPodcast(editor, { title: "No date", primaryArtistId: active.id, labelId }); await expect(publishPodcast(editor, missingDate.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "EPISODE_DATE_REQUIRED" });
    await expect(createPodcast(editor, { title: "Missing", primaryArtistId: crypto.randomUUID(), labelId })).rejects.toMatchObject({ code: "INVALID_RELATIONSHIP" }); await expect(createPodcast(viewer, { title: "Denied", primaryArtistId: active.id, labelId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.label.update({ where: { id: labelId }, data: { active: false } }); await expect(createPodcast(editor, { title: "Inactive", primaryArtistId: active.id, labelId })).rejects.toMatchObject({ code: "LABEL_INACTIVE" });
  });

  it("freezes scheduled chapters, cancels, and publishes idempotently", async () => {
    const primary = await artist(); const episode = await podcast(primary.id); await replacePodcastChapters(editor, episode.id, { expectedWorkingVersion: 1, chapters: chapterInput }); const future = new Date(Date.now() + 3600000);
    await schedulePodcast(editor, episode.id, { expectedWorkingVersion: 2, scheduledFor: future }); await cancelPodcastSchedule(editor, episode.id); await schedulePodcast(editor, episode.id, { expectedWorkingVersion: 2, scheduledFor: future }); await replacePodcastChapters(editor, episode.id, { expectedWorkingVersion: 2, chapters: [{ artist: "Later", title: "Later" }] });
    expect(await runScheduledPodcastPublication(new Date(future.getTime() - 1))).toEqual({ examined: 0, published: 0 }); expect(await runScheduledPodcastPublication(future)).toEqual({ examined: 1, published: 1 }); expect(await runScheduledPodcastPublication(future)).toEqual({ examined: 0, published: 0 });
    expect((await getPublishedPodcastForLegacy(episode.legacyId))?.publishedRevision?.chapters.map(({ title }) => title)).toEqual(["First", "Second"]);
  });

  it("unpublishes and restores without accidental republication", async () => {
    const primary = await artist(); const episode = await podcast(primary.id); await publishPodcast(editor, episode.id, { expectedWorkingVersion: 1 }); await unpublishPodcast(editor, episode.id); await archivePodcast(editor, episode.id); await restorePodcast(editor, episode.id);
    expect((await getPodcast(editor, episode.id)).status).toBe("UNPUBLISHED"); expect(await getPublishedPodcastForLegacy(episode.legacyId)).toBeNull();
  });

  it("serves pagination, transformations, and strict Track/Podcast type isolation", async () => {
    const primary = await artist("API Artist"); const track = await createTrack(editor, { title: "Normal Track", primaryArtistId: primary.id, labelId }); await publishTrack(editor, track.id, { expectedWorkingVersion: 1 }); const episode = await podcast(primary.id); await replacePodcastChapters(editor, episode.id, { expectedWorkingVersion: 1, chapters: chapterInput }); await publishPodcast(editor, episode.id, { expectedWorkingVersion: 2 });
    const body = await (await handleLegacyPodcastRequest(request("podcast", undefined, "&limit=1&offset=0"))).json(); expect(body).toMatchObject({ total_rows: 1, limit: "1", offset: "0" }); expect(body.tracks[0]).toMatchObject({ id: String(episode.legacyId), title: "Episode", label: "STEYOYOKE BLACK", date: "2026-08-09", artist_feature_times: [{ duration: "00:03:45", title: "First", id: "REF-1", artist: "Artist One" }, { duration: null, title: "Second", id: "", artist: "Artist Two" }] });
    expect((await (await handleLegacyPodcastRequest(request("podcast", track.legacyId), track.legacyId)).json()).tracks).toEqual([]); expect((await (await handleLegacyTrackRequest(request("track", episode.legacyId), episode.legacyId)).json()).tracks).toEqual([]);
  });
});
