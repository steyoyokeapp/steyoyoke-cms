import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCatalogue, mapLabel, normalizeLegacyUrl, parseLegacyChapters, parseLegacyDate, parseLegacyDuration, resolveArtworkSource } from "../../scripts/migration/analysis";
import { stableUuid } from "../../scripts/migration/identity";
import { extractTables } from "../../scripts/migration/legacy-dump";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("catalogue migration primitives", () => {
  it("extracts only explicitly allowed content tables and preserves raw escaped values", () => {
    const sql = [
      "INSERT INTO `artists` (`id`,`name`,`image`) VALUES (1,'Alice\\'s','cover.jpg');",
      "INSERT INTO `users` (`id`,`password`) VALUES (1,'secret');",
      "INSERT INTO `tracks` (`id`,`type`,`title`) VALUES (7,'track','One'),(8,'podcast','Two');",
      "INSERT INTO `releases` (`id`,`title`) VALUES (3,'Release');",
      "INSERT INTO `release_tracks` (`release_id`,`track_id`,`priority`) VALUES (3,7,0);",
    ].join("\n");
    const catalogue = extractTables(sql);
    expect(catalogue.artists[0]).toMatchObject({ id: "1", name: "Alice's", image: "cover.jpg" });
    expect(catalogue.tracks.map((row) => row.type)).toEqual(["track", "podcast"]);
    expect(JSON.stringify(catalogue)).not.toContain("secret");
  });

  it("maps only approved labels", () => {
    expect(mapLabel(" STEYOYOKE_BLACK ")).toBe("STEYOYOKE_BLACK");
    expect(mapLabel("Inner Symphony")).toBe("INNER_SYMPHONY");
    expect(mapLabel("UNKNOWN_RECORDS")).toBeNull();
  });

  it("parses valid durations and rejects ambiguous durations", () => {
    expect(parseLegacyDuration("03:05")).toBe(185_000);
    expect(parseLegacyDuration("1:03:05")).toBe(3_785_000);
    expect(parseLegacyDuration("")).toBeNull();
    expect(parseLegacyDuration("3:75")).toBeUndefined();
  });

  it("parses calendar dates strictly", () => {
    expect(parseLegacyDate("2024-02-29")).toEqual(new Date("2024-02-29T00:00:00.000Z"));
    expect(parseLegacyDate("")).toBeNull();
    expect(parseLegacyDate("2023-02-29")).toBeUndefined();
  });

  it("normalizes supported legacy URLs without accepting malformed schemes", () => {
    expect(normalizeLegacyUrl("http://example.com/path")).toBe("https://example.com/path");
    expect(normalizeLegacyUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(normalizeLegacyUrl("javascript:alert(1)")).toBeNull();
  });

  it("preserves clean chapters while retaining malformed evidence", () => {
    const parsed = parseLegacyChapters("Artist - Title 42;03:15\nbroken source line");
    expect(parsed.classification).toBe("PARSED WITH WARNING");
    expect(parsed.rows).toEqual([{ position: 0, artist: "Artist", title: "Title", legacyReference: "42", durationMs: 195_000 }]);
    expect(parsed.rejected).toEqual(["broken source line"]);
  });

  it("resolves a safe local artwork source without path traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "phase-11-artwork-")); temporaryDirectories.push(root);
    await mkdir(path.join(root, "covers")); await writeFile(path.join(root, "covers", "safe.jpg"), "fixture");
    await expect(resolveArtworkSource(root, { cover_download: "covers/safe.jpg" }, ["cover_download"])).resolves.toBe(path.join(root, "covers", "safe.jpg"));
    await expect(resolveArtworkSource(root, { cover_download: "../private.jpg" }, ["cover_download"])).resolves.toBeNull();
  });

  it("creates deterministic, scope-separated canonical identities", () => {
    expect(stableUuid("track", 7)).toBe(stableUuid("track", 7));
    expect(stableUuid("track", 7)).not.toBe(stableUuid("podcast", 7));
    expect(stableUuid("track", 7)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("splits Track and Podcast counts and records dangling relations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "phase-11-analysis-")); temporaryDirectories.push(root);
    const result = await analyzeCatalogue("fixture", {
      artists: [{ id: "1", name: "Artist" }],
      tracks: [
        { id: "10", type: "track", title: "Track", artist_id: "1", label: "STEYOYOKE", file_id: "audio-10" },
        { id: "11", type: "podcast", title: "Podcast", artist_id: "1", label: "STEYOYOKE", file_id: "audio-11", date: "2024-01-01", artist_feature_times: "Artist - Chapter 1;00:05" },
      ],
      releases: [{ id: "20", title: "Release", artist_id: "1", label: "STEYOYOKE", date: "2024-01-01" }],
      releaseTracks: [{ release_id: "20", track_id: "999", priority: "0" }],
    }, root);
    expect(result.counts).toMatchObject({ artists: 1, tracks: 1, podcasts: 1, releases: 1, releaseTracks: 1 });
    expect(result.chapters.get(11)?.rows).toHaveLength(1);
    expect(result.issues).toContainEqual(expect.objectContaining({ sourceTable: "release_tracks", field: "relation", problem: "Dangling ReleaseTrack relation." }));
  });
});
