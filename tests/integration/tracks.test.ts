import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { archiveArtist, createArtist, publishArtist, updateArtistDraft } from "@/modules/artists/service";
import { handleLegacyTrackRequest } from "@/modules/tracks/legacy";
import { archiveTrack, cancelTrackSchedule, createTrack, getPublishedTrackForLegacy, getTrack, publishTrack, restoreTrack, runScheduledTrackPublication, scheduleTrack, unpublishTrack, updateTrackDraft } from "@/modules/tracks/service";

let editor: Actor; let viewer: Actor; let labelId: string;
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "track_audit_logs", "track_revisions", "tracks", "audit_logs", "artist_revisions", "artists", "accounts", "sessions", "verifications", "users", "labels" RESTART IDENTITY CASCADE');
  const [editorUser, viewerUser] = await Promise.all([prisma.user.create({ data: { name: "Editor", email: "track-editor@test.local", role: "EDITOR", emailVerified: true } }), prisma.user.create({ data: { name: "Viewer", email: "track-viewer@test.local", role: "VIEWER", emailVerified: true } })]);
  editor = { userId: editorUser.id, role: "EDITOR" }; viewer = { userId: viewerUser.id, role: "VIEWER" };
  labelId = (await prisma.label.create({ data: { name: "Steyoyoke", slug: "steyoyoke", legacyValue: "STEYOYOKE" } })).id;
});
afterAll(async () => prisma.$disconnect());

async function artist(name = "Track Artist", publish = true) { const value = await createArtist(editor, { name }); if (publish) await publishArtist(editor, value.id, { expectedWorkingVersion: 1 }); return value; }
async function track(primaryArtistId: string, title = "Published Track") { return createTrack(editor, { title, primaryArtistId, labelId, durationMs: 225000, spotifyUrl: "https://spotify.test/track" }); }

describe("Track publication service", () => {
  it("uses the shared future Track/Podcast namespace beginning at 3337 and never mutates IDs", async () => {
    const primary = await artist(); const first = await track(primary.id); const second = await track(primary.id, "Second");
    expect([first.legacyId, second.legacyId]).toEqual([3337, 3338]);
    const sequence = await prisma.$queryRaw<Array<{ name: string | null }>>`SELECT pg_get_serial_sequence('tracks', 'legacyId') AS name`;
    expect(sequence[0]?.name).toBe("public.legacy_track_id_seq");
    await expect(prisma.track.update({ where: { id: first.id }, data: { legacyId: 9999 } })).rejects.toThrow(/immutable/);
  });

  it("isolates drafts, numbers revisions, and controls legacy visibility", async () => {
    const primary = await artist("Frozen Artist"); const value = await track(primary.id, "Revision One");
    expect(await getPublishedTrackForLegacy(value.legacyId)).toBeNull(); await publishTrack(editor, value.id, { expectedWorkingVersion: 1 });
    await updateTrackDraft(editor, value.id, { title: "Revision Two", primaryArtistId: primary.id, secondaryArtistId: "", labelId, durationMs: 225000, spotifyUrl: "https://spotify.test/track" , expectedWorkingVersion: 1 });
    expect((await getPublishedTrackForLegacy(value.legacyId))?.publishedRevision?.title).toBe("Revision One");
    await publishTrack(editor, value.id, { expectedWorkingVersion: 2 }); const detail = await getTrack(editor, value.id);
    expect(detail.revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([2, 1]); expect(detail.publishedRevision?.title).toBe("Revision Two");
    await unpublishTrack(editor, value.id); expect(await getPublishedTrackForLegacy(value.legacyId)).toBeNull();
    await archiveTrack(editor, value.id); await restoreTrack(editor, value.id); expect((await getTrack(editor, value.id)).status).toBe("UNPUBLISHED");
  });

  it("freezes deterministic Artist/Label snapshots and immutable scheduled revisions", async () => {
    const primary = await artist("Snapshot Artist"); const value = await track(primary.id); const due = new Date("2032-01-01T00:00:00Z");
    await scheduleTrack(editor, value.id, { expectedWorkingVersion: 1, scheduledFor: due });
    await updateTrackDraft(editor, value.id, { title: "Later draft", primaryArtistId: primary.id, secondaryArtistId: "", labelId, durationMs: null, expectedWorkingVersion: 1 });
    expect(await runScheduledTrackPublication(new Date("2031-12-31T23:59:59Z"))).toEqual({ examined: 0, published: 0 });
    expect(await runScheduledTrackPublication(due)).toEqual({ examined: 1, published: 1 }); expect(await runScheduledTrackPublication(due)).toEqual({ examined: 0, published: 0 });
    await updateArtistDraft(editor, primary.id, { name: "Artist working edit", slug: primary.slug, shortBio: "", facebookUrl: "", expectedWorkingVersion: 1 });
    await prisma.label.update({ where: { id: labelId }, data: { name: "Renamed Label", active: false } });
    const delivered = await getPublishedTrackForLegacy(value.legacyId); expect(delivered?.publishedRevision?.title).toBe("Published Track"); expect(delivered?.publishedRevision?.primaryArtistName).toBe("Snapshot Artist"); expect(delivered?.publishedRevision?.labelName).toBe("Steyoyoke"); expect(delivered?.publishedRevision?.labelLegacyValue).toBe("STEYOYOKE");
    await expect(prisma.trackRevision.update({ where: { id: delivered!.publishedRevision!.id }, data: { title: "Tampered" } })).rejects.toThrow(/immutable/);
    await expect(prisma.label.update({ where: { id: labelId }, data: { legacyValue: "CHANGED" } })).rejects.toThrow(/immutable/);
  });

  it("enforces Artist and Label dependencies", async () => {
    const unpublished = await artist("Draft Artist", false); const archived = await artist("Archived Artist"); await archiveArtist(editor, archived.id);
    const draftTrack = await track(unpublished.id); await expect(publishTrack(editor, draftTrack.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "PRIMARY_ARTIST_NOT_PUBLISHABLE" });
    const archivedTrack = await track(archived.id); await expect(publishTrack(editor, archivedTrack.id, { expectedWorkingVersion: 1 })).rejects.toMatchObject({ code: "PRIMARY_ARTIST_NOT_PUBLISHABLE" });
    await expect(createTrack(editor, { title: "Missing", primaryArtistId: crypto.randomUUID(), labelId })).rejects.toMatchObject({ code: "INVALID_RELATIONSHIP" });
    const active = await artist("Active"); await expect(createTrack(editor, { title: "Same", primaryArtistId: active.id, secondaryArtistId: active.id, labelId })).rejects.toThrow(/Secondary Artist/);
    await expect(createTrack(viewer, { title: "Denied", primaryArtistId: active.id, labelId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cancels schedules and audits the complete lifecycle", async () => {
    const primary = await artist(); const value = await track(primary.id); const future = new Date(Date.now() + 3600000);
    await scheduleTrack(editor, value.id, { expectedWorkingVersion: 1, scheduledFor: future }); await cancelTrackSchedule(editor, value.id); await publishTrack(editor, value.id, { expectedWorkingVersion: 1 }); await unpublishTrack(editor, value.id); await archiveTrack(editor, value.id); await restoreTrack(editor, value.id);
    expect((await getTrack(editor, value.id)).auditLogs.map(({ action }) => action)).toEqual(["RESTORE", "ARCHIVE", "UNPUBLISH", "PUBLISH", "CANCEL_SCHEDULE", "SCHEDULE", "CREATE"]);
  });

  it("serves typed pagination, Label/link mapping, and single-ID visibility", async () => {
    const primary = await artist(); const first = await track(primary.id, "First"); const second = await track(primary.id, "Second"); await publishTrack(editor, first.id, { expectedWorkingVersion: 1 }); await publishTrack(editor, second.id, { expectedWorkingVersion: 1 });
    const request = new Request("http://local/index.php/cms/api?filter=tracks&type=track&limit=1&offset=0", { headers: { "X-Csrf-Token": process.env.LEGACY_API_KEY_A! } }); const response = await handleLegacyTrackRequest(request); const body = await response.json();
    expect(body).toMatchObject({ total_rows: 2, limit: "1", offset: "0" }); expect(body.tracks[0]).toMatchObject({ id: String(second.legacyId), label: "STEYOYOKE", duration: "00:03:45", spotify_link: "https://spotify.test/track" });
    expect((await (await handleLegacyTrackRequest(new Request(`http://local/index.php/cms/api/${first.legacyId}?filter=tracks&type=track`, { headers: { "X-Csrf-Token": process.env.LEGACY_API_KEY_A! } }), first.legacyId)).json()).tracks).toHaveLength(1);
  });
});
