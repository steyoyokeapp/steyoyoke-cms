import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { archiveArtist, createArtist, publishArtist } from "@/modules/artists/service";
import { GET as legacyCollectionGET } from "@/app/index.php/cms/api/route";
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

describe("legacy iOS Podcast Artist filter", () => {
  const artistsRequest = (authorized = true) => new Request("http://local/index.php/cms/api?filter=allpodcastartist", { headers: authorized ? { "X-Csrf-Token": process.env.LEGACY_API_KEY_A! } : {} });
  it("requires authorization and returns the exact empty envelope", async () => {
    expect((await legacyCollectionGET(artistsRequest(false))).status).toBe(401);
    const response = await legacyCollectionGET(artistsRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ allpodcastartist: [] });
  });
  it("sorts and deduplicates visible frozen names, excluding nonpublic episodes and unrelated Artists", async () => {
    const z = await artist("Zeta"); const a = await artist("Alpha"); const hidden = await artist("Hidden"); await artist("Unused");
    for (const id of [z.id, a.id, a.id]) { const ep = await podcast(id); await publishPodcast(editor, ep.id, { expectedWorkingVersion: 1 }); }
    const draft = await podcast(hidden.id);
    await schedulePodcast(editor, draft.id, { expectedWorkingVersion: 1, scheduledFor: new Date(Date.now()+3600000) });
    const archived = await podcast(hidden.id); await publishPodcast(editor, archived.id, { expectedWorkingVersion: 1 }); await archivePodcast(editor, archived.id);
    const unpublished = await podcast(hidden.id); await publishPodcast(editor, unpublished.id, { expectedWorkingVersion: 1 }); await unpublishPodcast(editor, unpublished.id);
    await prisma.artist.update({ where: { id: a.id }, data: { name: "Working rename" } });
    expect(await (await legacyCollectionGET(artistsRequest())).json()).toEqual({ allpodcastartist: [{ artist_name: "Alpha" }, { artist_name: "Zeta" }] });
    expect((await legacyCollectionGET(request("podcast"))).status).toBe(200);
    expect((await legacyCollectionGET(request("track"))).status).toBe(200);
  });
});

describe("atomic Podcast core and chapter save", () => {
  it("updates core and ordered chapters once without altering a published snapshot", async () => {
    const primary = await artist(); const ep = await podcast(primary.id); await publishPodcast(editor, ep.id, { expectedWorkingVersion: 1 });
    const saved = await updatePodcastDraft(editor, ep.id, { title: "Atomic update", primaryArtistId: primary.id, labelId, episodeDate: "2026-08-09", expectedWorkingVersion: 1, chapters: chapterInput });
    expect(saved.workingVersion).toBe(2);
    expect((await prisma.podcastChapter.findMany({ where: { episodeId: ep.id }, orderBy: { position: "asc" } })).map(c=>c.title)).toEqual(["First", "Second"]);
    expect((await getPublishedPodcastForLegacy(ep.legacyId))?.publishedRevision?.title).toBe("Steyoyoke Episode");
    expect((await getPublishedPodcastForLegacy(ep.legacyId))?.publishedRevision?.chapters).toEqual([]);
  });
  it("rolls back core and chapters on a database failure after updates", async () => {
    const primary = await artist(); const ep = await podcast(primary.id); await replacePodcastChapters(editor, ep.id, { expectedWorkingVersion: 1, chapters: chapterInput });
    const before = await prisma.podcastChapter.findMany({ where: { episodeId: ep.id }, orderBy: { position: "asc" } });
    await expect(updatePodcastDraft({ role: "EDITOR", userId: crypto.randomUUID() }, ep.id, { title: "Must roll back", primaryArtistId: primary.id, labelId, expectedWorkingVersion: 2, chapters: [] })).rejects.toThrow();
    const after = await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: ep.id } });
    expect(after.title).toBe(ep.title); expect(after.workingVersion).toBe(2);
    expect(await prisma.podcastChapter.findMany({ where: { episodeId: ep.id }, orderBy: { position: "asc" } })).toEqual(before);
  });
  it("rejects invalid chapters and stale saves without mutating core", async () => {
    const primary = await artist(); const ep = await podcast(primary.id);
    const data = { title: "Must not save", primaryArtistId: primary.id, labelId, expectedWorkingVersion: 1 };
    await expect(updatePodcastDraft(editor, ep.id, { ...data, chapters: [{ artist: "", title: "Invalid" }] })).rejects.toThrow();
    await expect(updatePodcastDraft(editor, ep.id, { ...data, expectedWorkingVersion: 2, chapters: [] })).rejects.toMatchObject({ code: "WORKING_VERSION_CONFLICT" });
    expect((await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: ep.id } })).title).toBe(ep.title);
  });
});

describe("Podcast creation with chapters", () => {
  it("creates the initial ordered tracklist in the same transaction", async () => {
    const primary = await artist();
    const created = await createPodcast(editor, { title: "Complete new Podcast", primaryArtistId: primary.id, labelId, chapters: chapterInput });
    const stored = await getPodcast(editor, created.id);
    expect(stored.workingVersion).toBe(1);
    expect(stored.chapters.map(c => ({ title: c.title, position: c.position, durationMs: c.durationMs }))).toEqual(chapterInput.map((c, position) => ({ title: c.title, position, durationMs: c.durationMs })));
    expect(stored.chapters[0]?.legacyReference).toBe("REF-1");
  });
  it("rejects invalid initial chapters without creating a draft", async () => {
    const primary = await artist();
    await expect(createPodcast(editor, { title: "Invalid initial tracklist", primaryArtistId: primary.id, labelId, chapters: [{ title: "", artist: "Someone" }] })).rejects.toThrow();
    expect(await prisma.podcastEpisode.count()).toBe(0);
  });
});

it("derives Podcast duration from READY audio and preserves it on ordinary saves", async () => {
  const primary = await artist(); const ep = await podcast(primary.id);
  expect(ep.durationMs).toBe(1000);
  const edited = await updatePodcastDraft(editor, ep.id, { title: "Duration preserved", primaryArtistId: primary.id, labelId, expectedWorkingVersion: 1 });
  expect(edited.durationMs).toBe(1000);
  const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: audioAssetId } });
  const replacement = await prisma.mediaAsset.create({ data: { ...source, audioDelivery: undefined, id: crypto.randomUUID(), sourceStorageKey: "test/replacement.mp3", legacyAudioId: crypto.randomUUID(), durationMs: 6993518 } });
  const replaced = await updatePodcastDraft(editor, ep.id, { title: edited.title, primaryArtistId: primary.id, labelId, audioAssetId: replacement.id, durationMs: 1, expectedWorkingVersion: 2 });
  expect(replaced.durationMs).toBe(6993518);
});

describe("validated bulk tracklist atomic save", () => {
  it("validates raw text on the server, preserves references and freezes the structured result", async () => {
    const primary=await artist();const source=await prisma.mediaAsset.findUniqueOrThrow({where:{id:audioAssetId}});audioAssetId=(await prisma.mediaAsset.create({data:{...source,audioDelivery:undefined,id:crypto.randomUUID(),sourceStorageKey:"test/bulk-long.mp3",legacyAudioId:crypto.randomUUID(),durationMs:7200000}})).id;
    const ep=await podcast(primary.id);
    await replacePodcastChapters(editor,ep.id,{expectedWorkingVersion:1,chapters:[{artist:"D-Nox",title:"Opening",durationMs:0,legacyReference:"KEEP-REF"}]});
    await publishPodcast(editor,ep.id,{expectedWorkingVersion:2});
    await updatePodcastDraft(editor,ep.id,{title:"Bulk edited",primaryArtistId:primary.id,labelId,episodeDate:"2026-08-09",expectedWorkingVersion:2,tracklist:"D-Nox - Opening 1;00:00\nA - Long mix 2;01:02:03"});
    const working=await getPodcast(editor,ep.id);expect(working.chapters.map(c=>[c.artist,c.title,c.durationMs,c.legacyReference])).toEqual([["D-Nox","Opening",0,"KEEP-REF"],["A","Long mix",3723000,"2"]]);
    expect(working.publishedRevision?.chapters).toHaveLength(1);
    await publishPodcast(editor,ep.id,{expectedWorkingVersion:3});
    const legacy=await (await handleLegacyPodcastRequest(request("podcast",ep.legacyId),ep.legacyId)).json();expect(legacy.tracks[0].artist_feature_times[1]).toEqual({artist:"A",title:"Long mix",duration:"01:02:03",id:"2"});
  });
  it("rolls back core, working version, chapters and audit when strict validation fails", async () => {
    const primary=await artist(),ep=await podcast(primary.id);const before=await getPodcast(editor,ep.id);
    for(const tracklist of ["A - B 1:00:00","A - B 1;00:01","A - B 2;00:00"]){await expect(updatePodcastDraft(editor,ep.id,{title:"Never saved",primaryArtistId:primary.id,labelId,expectedWorkingVersion:1,tracklist})).rejects.toMatchObject({code:"TRACKLIST_INVALID"});expect(await getPodcast(editor,ep.id)).toEqual(before);}
    await expect(createPodcast(editor,{title:"Invalid",primaryArtistId:primary.id,labelId,tracklist:"A - B 1:00:00"})).rejects.toMatchObject({code:"TRACKLIST_INVALID"});expect(await prisma.podcastEpisode.count()).toBe(1);
  });
  it("creates valid text and atomically clears an intentionally empty tracklist", async () => {
    const primary=await artist();const ep=await createPodcast(editor,{title:"Bulk",primaryArtistId:primary.id,labelId,tracklist:"A - B 1;75:12"});expect((await getPodcast(editor,ep.id)).chapters[0]?.durationMs).toBe(4512000);
    await updatePodcastDraft(editor,ep.id,{title:"Empty",primaryArtistId:primary.id,labelId,expectedWorkingVersion:1,tracklist:"\n "});expect((await getPodcast(editor,ep.id)).chapters).toEqual([]);
  });
});
