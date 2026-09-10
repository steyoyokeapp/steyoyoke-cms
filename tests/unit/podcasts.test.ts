import { describe, expect, it } from "vitest";
import type { PodcastChapterRevision, PodcastEpisodeRevision } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/authorization";
import { legacyPodcastDate, legacyPodcastLabel, legacyPodcastTitle, serializeLegacyPodcast } from "@/modules/podcasts/legacy";
import { normalizePodcastChapters, podcastDraftSchema } from "@/modules/podcasts/schema";

const primaryId = crypto.randomUUID(); const labelId = crypto.randomUUID(); const revisionId = crypto.randomUUID();
const revision = { id: revisionId, episodeId: crypto.randomUUID(), revisionNumber: 1, sourceWorkingVersion: 2, title: "Steyoyoke Example", primaryArtistId: primaryId, primaryArtistLegacyId: 400, primaryArtistName: "Published Artist", secondaryArtistId: null, secondaryArtistLegacyId: null, secondaryArtistName: null, labelId, labelName: "Steyoyoke Black", labelLegacyValue: "STEYOYOKE_BLACK", episodeDate: new Date("2026-01-02T00:00:00.000Z"), durationMs: 3825000, artworkAssetId: null, audioAssetId: null, createdById: crypto.randomUUID(), createdAt: new Date() } satisfies PodcastEpisodeRevision;
const chapters = [{ id: crypto.randomUUID(), episodeRevisionId: revisionId, sourceChapterId: null, position: 0, artist: "Artist A", title: "Opening", legacyReference: null, durationMs: 225000 }] satisfies PodcastChapterRevision[];

describe("Podcast validation", () => {
  it("requires title, real-shaped IDs, nonnegative duration, and distinct Artists", () => {
    expect(podcastDraftSchema.safeParse({ title: "", primaryArtistId: primaryId, labelId }).success).toBe(false);
    expect(podcastDraftSchema.safeParse({ title: "Episode", primaryArtistId: primaryId, secondaryArtistId: primaryId, labelId }).success).toBe(false);
    expect(podcastDraftSchema.safeParse({ title: "Episode", primaryArtistId: primaryId, labelId, durationMs: -1 }).success).toBe(false);
  });
  it("validates and normalizes submitted chapter order", () => {
    expect(normalizePodcastChapters([{ position: 12, artist: " A ", title: " First ", legacyReference: "", durationMs: null }, { position: 3, artist: "B", title: "Second", legacyReference: "x", durationMs: 0 }])).toEqual([
      { position: 0, artist: "A", title: "First", legacyReference: null, durationMs: null }, { position: 1, artist: "B", title: "Second", legacyReference: "x", durationMs: 0 },
    ]);
    expect(() => normalizePodcastChapters([{ artist: "", title: "Invalid" }])).toThrow();
  });
});

describe("Podcast legacy transformations", () => {
  it.each([["Steyoyoke Example", "Example"], ["STEYOYOKE Example", "STEYOYOKE Example"], ["Example", "Example"]])("transforms title %s", (input, expected) => expect(legacyPodcastTitle(input)).toBe(expected));
  it.each([["STEYOYOKE", "STEYOYOKE"], ["STEYOYOKE_BLACK", "STEYOYOKE BLACK"], ["INNER_SYMPHONY", "INNER SYMPHONY"]])("transforms label %s", (input, expected) => expect(legacyPodcastLabel(input)).toBe(expected));
  it("serializes date in UTC and structured chapters deterministically", () => {
    expect(legacyPodcastDate(new Date("2026-01-02T23:59:59-11:00"))).toBe("2026-01-03");
    const result = serializeLegacyPodcast({ ...revision, chapters }, 3338);
    expect(result).toMatchObject({ id: "3338", title: "Example", date: "2026-01-02", duration: "01:03:45", label: "STEYOYOKE BLACK", type: "podcast", file_id: null, artist_name: "Published Artist" });
    expect(result.artist_feature_times).toEqual([{ duration: "00:03:45", title: "Opening", id: "", artist: "Artist A" }]);
  });
  it("preserves multilingual punctuation and UTF-8 chapter text deterministically", () => {
    const special = [
      { artist: "Beyoncé & O’Connor", title: "L'été -- intro – bridge — finale; live 🎛️" },
      { artist: "София", title: "Привет — мир" },
      { artist: "ليلى", title: "موسيقى؛ بداية" },
    ].map((chapter, position) => ({ id: crypto.randomUUID(), episodeRevisionId: revisionId, sourceChapterId: null, position, legacyReference: null, durationMs: position * 1000, ...chapter })) satisfies PodcastChapterRevision[];
    const first = serializeLegacyPodcast({ ...revision, title: "Steyoyoke Épisode — ليلى 🎧", chapters: special }, 3338);
    const second = serializeLegacyPodcast({ ...revision, title: "Steyoyoke Épisode — ليلى 🎧", chapters: special }, 3338);
    expect(first.title).toBe("Épisode — ليلى 🎧");
    expect(first.artist_feature_times.map(({ artist, title }) => ({ artist, title }))).toEqual(special.map(({ artist, title }) => ({ artist, title })));
    expect(JSON.parse(JSON.stringify(first))).toEqual(second);
  });
  it("enforces Podcast-specific permissions", () => {
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "EDITOR" }, "podcast:write")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "podcast:read")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "podcast:write")).toThrow(/permission/);
  });
});
