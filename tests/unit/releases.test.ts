import { describe, expect, it } from "vitest";
import type { ReleaseRevision, TrackRevision } from "@/generated/prisma/client";
import { legacyReleaseDate, legacyReleaseLabel, legacyReleaseTitle, serializeLegacyRelease, serializeLegacyReleaseCompleteTrack } from "@/modules/releases/legacy";
import { normalizeReleaseTrackIds, releaseDraftSchema } from "@/modules/releases/schema";

const releaseRevision = {
  title: "Steyoyoke Frozen Horizon", primaryArtistLegacyId: 41, primaryArtistName: "Primary", secondaryArtistLegacyId: 42, secondaryArtistName: "Secondary",
  releaseDate: new Date("2026-07-08T00:00:00.000Z"), labelLegacyValue: "STEYOYOKE_BLACK",
  bandcampUrl: "https://bandcamp.test/release", appleMusicUrl: "https://music.test/release", beatportUrl: "https://beatport.test/release",
  traxsourceUrl: "https://traxsource.test/release", spotifyUrl: "https://spotify.test/release", soundcloudUrl: "https://soundcloud.test/release",
} as ReleaseRevision;

describe("Release validation and compatibility", () => {
  it("validates HTTPS links, distinct Artists, and normalizes unique ordering", () => {
    const base = { title: "Release", primaryArtistId: crypto.randomUUID(), labelId: crypto.randomUUID(), releaseDate: "2026-07-08" };
    expect(releaseDraftSchema.safeParse({ ...base, spotifyUrl: "http://invalid.test" }).success).toBe(false);
    expect(releaseDraftSchema.safeParse({ ...base, secondaryArtistId: base.primaryArtistId }).success).toBe(false);
    const ids = [crypto.randomUUID(), crypto.randomUUID()]; expect(normalizeReleaseTrackIds(ids)).toEqual(ids); expect(() => normalizeReleaseTrackIds([ids[0], ids[0]])).toThrow(/once/);
  });

  it("preserves exact Release title, label, date, and link mappings", () => {
    expect(legacyReleaseTitle("Steyoyoke Title")).toBe("Title"); expect(legacyReleaseTitle("steyoyoke Title")).toBe("steyoyoke Title");
    expect(["STEYOYOKE", "STEYOYOKE_BLACK", "INNER_SYMPHONY"].map(legacyReleaseLabel)).toEqual(["STEYOYOKE", "STEYOYOKE BLACK", "INNER SYMPHONY"]);
    expect(legacyReleaseDate(releaseRevision.releaseDate)).toBe("2026-07-08");
    expect(serializeLegacyRelease(releaseRevision, 649, "single")).toMatchObject({ id: "649", title: "Frozen Horizon", label: "STEYOYOKE BLACK", web_link: releaseRevision.bandcampUrl, itunes_link: releaseRevision.appleMusicUrl, beatport_link: releaseRevision.beatportUrl, traxsource_link: releaseRevision.traxsourceUrl, spotify_link: releaseRevision.spotifyUrl, soundcloud_link: releaseRevision.soundcloudUrl, cover_download: null });
  });

  it("preserves mode-specific artist aliases", () => {
    const paginated = serializeLegacyRelease(releaseRevision, 649, "paginated"); const unpaginated = serializeLegacyRelease(releaseRevision, 649, "unpaginated"); const single = serializeLegacyRelease(releaseRevision, 649, "single");
    expect(paginated).toMatchObject({ artist_name: "Primary", secondary_artist_name: "Secondary" });
    expect(unpaginated).toMatchObject({ artist_name: "Primary" }); expect(unpaginated).not.toHaveProperty("secondary_artist_name");
    expect(single).not.toHaveProperty("artist_name"); expect(single).not.toHaveProperty("secondary_artist_name");
  });

  it("serializes releasecomplete Tracks with endpoint-specific frozen aliases", () => {
    const trackRevision = { title: "Steyoyoke Frozen Track", primaryArtistLegacyId: 51, primaryArtistName: "Track Artist", secondaryArtistLegacyId: 52, secondaryArtistName: "Track Feature", labelLegacyValue: "INNER_SYMPHONY", durationMs: 225000, appleMusicUrl: null, beatportUrl: null, bandcampUrl: null, traxsourceUrl: null, spotifyUrl: null, soundcloudUrl: null } as TrackRevision;
    const output = serializeLegacyReleaseCompleteTrack(trackRevision, 3337); expect(output).toMatchObject({ id: "3337", title: "Frozen Track", label: "INNER SYMPHONY", artist_track_name: "Track Artist", secondary_artist_track_name: "Track Feature" }); expect(output).not.toHaveProperty("artist_name");
  });
});
