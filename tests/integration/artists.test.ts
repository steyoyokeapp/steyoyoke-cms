import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/authorization";
import {
  archiveArtist,
  cancelArtistSchedule,
  createArtist,
  getArtist,
  getPublishedArtistForLegacy,
  hardDeleteArtist,
  publishArtist,
  restoreArtist,
  runScheduledArtistPublication,
  scheduleArtist,
  unpublishArtist,
  updateArtistDraft,
} from "@/modules/artists/service";

let admin: Actor;
let editor: Actor;
let viewer: Actor;

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs", "artist_revisions", "artists", "accounts", "sessions", "verifications", "users" RESTART IDENTITY CASCADE');
  const users = await Promise.all([
    prisma.user.create({ data: { name: "Admin", email: "admin@test.local", role: "ADMIN", emailVerified: true } }),
    prisma.user.create({ data: { name: "Editor", email: "editor@test.local", role: "EDITOR", emailVerified: true } }),
    prisma.user.create({ data: { name: "Viewer", email: "viewer@test.local", role: "VIEWER", emailVerified: true } }),
  ]);
  admin = { userId: users[0]!.id, role: "ADMIN" };
  editor = { userId: users[1]!.id, role: "EDITOR" };
  viewer = { userId: users[2]!.id, role: "VIEWER" };
});

afterAll(async () => prisma.$disconnect());

describe("artist publication service", () => {
  it("allocates stable legacy ids and deterministic slugs", async () => {
    const first = await createArtist(editor, { name: "Âme" });
    const second = await createArtist(editor, { name: "Ame" });
    expect(first.legacyId).toBe(400);
    expect(second.legacyId).toBe(401);
    expect(first.slug).toBe("ame");
    expect(second.slug).toBe("ame-2");
  });

  it("keeps post-publication draft edits out of legacy delivery", async () => {
    const artist = await createArtist(editor, { name: "Frozen Name", shortBio: "Published bio" });
    await publishArtist(editor, artist.id, { expectedWorkingVersion: 1 });
    await updateArtistDraft(editor, artist.id, {
      name: "Draft Name", slug: artist.slug, shortBio: "Draft bio", facebookUrl: "",
      expectedWorkingVersion: 1,
    });
    const delivered = await getPublishedArtistForLegacy(artist.legacyId);
    expect(delivered?.publishedRevision?.name).toBe("Frozen Name");
    expect(delivered?.publishedRevision?.shortBio).toBe("Published bio");
    expect((await getArtist(editor, artist.id)).name).toBe("Draft Name");
  });

  it("freezes scheduled content and publishes it once", async () => {
    const artist = await createArtist(editor, { name: "Scheduled Snapshot" });
    const due = new Date("2030-01-01T12:00:00.000Z");
    await scheduleArtist(editor, artist.id, { scheduledFor: due, expectedWorkingVersion: 1 });
    await updateArtistDraft(editor, artist.id, {
      name: "Later Draft", slug: artist.slug, shortBio: "", facebookUrl: "",
      expectedWorkingVersion: 1,
    });
    expect(await runScheduledArtistPublication(new Date("2030-01-01T11:59:59.000Z"))).toEqual({ examined: 0, published: 0 });
    expect(await runScheduledArtistPublication(due)).toEqual({ examined: 1, published: 1 });
    expect(await runScheduledArtistPublication(due)).toEqual({ examined: 0, published: 0 });
    const delivered = await getPublishedArtistForLegacy(artist.legacyId);
    expect(delivered?.publishedRevision?.name).toBe("Scheduled Snapshot");
  });

  it("rejects stale edits and viewer writes", async () => {
    const artist = await createArtist(editor, { name: "Concurrency" });
    await updateArtistDraft(editor, artist.id, {
      name: "First save", slug: artist.slug, shortBio: "", facebookUrl: "", expectedWorkingVersion: 1,
    });
    await expect(updateArtistDraft(editor, artist.id, {
      name: "Stale save", slug: artist.slug, shortBio: "", facebookUrl: "", expectedWorkingVersion: 1,
    })).rejects.toMatchObject({ code: "WORKING_VERSION_CONFLICT", status: 409 });
    await expect(createArtist(viewer, { name: "Denied" })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("limits permanent deletion to eligible admin drafts", async () => {
    const draft = await createArtist(editor, { name: "Disposable" });
    await expect(hardDeleteArtist(editor, draft.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await hardDeleteArtist(admin, draft.id);
    await expect(getArtist(admin, draft.id)).rejects.toMatchObject({ code: "ARTIST_NOT_FOUND" });
    const published = await createArtist(editor, { name: "Permanent history" });
    await publishArtist(editor, published.id, { expectedWorkingVersion: 1 });
    await expect(hardDeleteArtist(admin, published.id)).rejects.toMatchObject({ code: "HARD_DELETE_INELIGIBLE" });
  });

  it("records audit events and rejects revision mutation in PostgreSQL", async () => {
    const artist = await createArtist(editor, { name: "Evidence" });
    await publishArtist(editor, artist.id, { expectedWorkingVersion: 1 });
    const detail = await getArtist(admin, artist.id);
    expect(detail.auditLogs.map((entry) => entry.action)).toEqual(["PUBLISH", "CREATE"]);
    await expect(prisma.artistRevision.update({
      where: { id: detail.revisions[0]!.id }, data: { name: "Tampered" },
    })).rejects.toThrow(/immutable/);
    await expect(prisma.artist.update({
      where: { id: artist.id }, data: { legacyId: 9999 },
    })).rejects.toThrow(/immutable/);
  });

  it("audits the full lifecycle and keeps an unpublished scheduled artist hidden", async () => {
    const artist = await createArtist(editor, { name: "Lifecycle" });
    const future = new Date(Date.now() + 3_600_000);
    await scheduleArtist(editor, artist.id, { scheduledFor: future, expectedWorkingVersion: 1 });
    await cancelArtistSchedule(editor, artist.id);
    await publishArtist(editor, artist.id, { expectedWorkingVersion: 1 });
    await unpublishArtist(editor, artist.id);
    await scheduleArtist(editor, artist.id, { scheduledFor: future, expectedWorkingVersion: 1 });
    expect(await getPublishedArtistForLegacy(artist.legacyId)).toBeNull();
    await cancelArtistSchedule(editor, artist.id);
    await publishArtist(editor, artist.id, { expectedWorkingVersion: 1 });
    await archiveArtist(editor, artist.id);
    await restoreArtist(editor, artist.id);
    const detail = await getArtist(admin, artist.id);
    expect(detail.auditLogs.map(({ action }) => action)).toEqual([
      "RESTORE", "ARCHIVE", "PUBLISH", "CANCEL_SCHEDULE", "SCHEDULE",
      "UNPUBLISH", "PUBLISH", "CANCEL_SCHEDULE", "SCHEDULE", "CREATE",
    ]);
  });
});
