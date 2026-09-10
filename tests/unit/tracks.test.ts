import { describe, expect, it } from "vitest";
import type { TrackRevision } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/authorization";
import { formatDuration, formatLegacyDuration, parseDuration } from "@/modules/tracks/duration";
import { serializeLegacyTrack } from "@/modules/tracks/legacy";
import { trackDraftSchema } from "@/modules/tracks/schema";

const ids = { primary: crypto.randomUUID(), secondary: crypto.randomUUID(), label: crypto.randomUUID() };
const revision = {
  artworkAssetId: null,
  audioAssetId: null,
  id: crypto.randomUUID(), trackId: crypto.randomUUID(), revisionNumber: 1, sourceWorkingVersion: 1,
  title: "Raw_Title", primaryArtistId: ids.primary, primaryArtistLegacyId: 400, primaryArtistName: "Published Artist",
  secondaryArtistId: ids.secondary, secondaryArtistLegacyId: 401, secondaryArtistName: "Second",
  labelId: ids.label, labelName: "Steyoyoke Black", labelLegacyValue: "STEYOYOKE_BLACK", durationMs: 225000,
  spotifyUrl: "https://spotify.test/track", beatportUrl: "https://beatport.test/track", traxsourceUrl: null,
  bandcampUrl: "https://bandcamp.test/track", appleMusicUrl: "https://music.test/track", soundcloudUrl: null,
  createdById: crypto.randomUUID(), createdAt: new Date(),
} satisfies TrackRevision;

describe("Track duration", () => {
  it("parses and formats accepted values", () => {
    expect(parseDuration("")).toBeNull(); expect(parseDuration("00:00")).toBe(0); expect(parseDuration("03:45")).toBe(225000); expect(parseDuration("01:03:45")).toBe(3825000);
    expect(formatDuration(null)).toBeNull(); expect(formatDuration(0)).toBe("00:00"); expect(formatLegacyDuration(3825000)).toBe("01:03:45");
  });
  it.each(["3:45", "03:60", "1:03:45", "00:01:02:03", "abc"])("rejects malformed duration %s", (value) => expect(() => parseDuration(value)).toThrow());
});

describe("Track validation and compatibility", () => {
  it("requires HTTPS URLs and distinct Artists", () => {
    expect(trackDraftSchema.safeParse({ title: "A", primaryArtistId: ids.primary, labelId: ids.label, spotifyUrl: "http://unsafe.test" }).success).toBe(false);
    expect(trackDraftSchema.safeParse({ title: "A", primaryArtistId: ids.primary, secondaryArtistId: ids.primary, labelId: ids.label }).success).toBe(false);
  });
  it("maps frozen delivery fields without obsolete canonical storage", () => {
    const track = serializeLegacyTrack(revision, 3337);
    expect(track).toMatchObject({ id: "3337", title: "Raw_Title", artist_id: "400", secondary_artist_id: "401", duration: "00:03:45", label: "STEYOYOKE_BLACK", type: "track", itunes_link: revision.appleMusicUrl, web_link: revision.bandcampUrl, artist_name: "Published Artist" });
    expect(track).not.toHaveProperty("secondary_artist_name"); expect(track.file_id).toBeNull(); expect(track.cover_high).toBeNull();
  });
  it("enforces Track-specific read/write permissions", () => {
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "EDITOR" }, "track:write")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "track:read")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "track:write")).toThrow(/permission/);
  });
});
