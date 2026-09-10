import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCatalogue, mapLabel, normalizeLegacyUrl, parseLegacyChapters, parseLegacyDate, parseLegacyDuration, resolveArtworkSource, resolveArtworkSourceDetailed } from "../../scripts/migration/analysis";
import { stableUuid } from "../../scripts/migration/identity";
import { extractTables } from "../../scripts/migration/legacy-dump";
import { buildMigrationManifest } from "../../scripts/migration/manifest";

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

  it("normalizes Podcast 1750's unambiguous single-digit day", () => {
    expect(parseLegacyDate("2018-01-9")).toEqual(new Date("2018-01-09T00:00:00.000Z"));
    expect(parseLegacyDate("2018-1-09")).toEqual(new Date("2018-01-09T00:00:00.000Z"));
    expect(parseLegacyDate("01-09-2018")).toBeUndefined();
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

  it("preserves special characters and safely normalizes legacy chapter timestamps", () => {
    const source = [
      "Beyoncé & O’Connor - L'été (Part-One--Two) 1;01:02:03",
      "Zoë — Артист - عنوان; subtitle 😎 2; 25 : 06",
      "München – القاهرة - Rock'n'Roll & More 3;03:15",
    ].join("\r\n");
    const parsed = parseLegacyChapters(source);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.normalized.map(({ rule }) => rule)).toEqual(["HOURS_MINUTES_SECONDS", "TIMESTAMP_WHITESPACE"]);
    expect(JSON.parse(JSON.stringify(parsed.rows))).toEqual([
      { position: 0, artist: "Beyoncé & O’Connor", title: "L'été (Part-One--Two)", legacyReference: "1", durationMs: 3_723_000 },
      { position: 1, artist: "Zoë — Артист", title: "عنوان; subtitle 😎", legacyReference: "2", durationMs: 1_506_000 },
      { position: 2, artist: "München – القاهرة", title: "Rock'n'Roll & More", legacyReference: "3", durationMs: 195_000 },
    ]);
  });

  it("resolves a safe local artwork source without path traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "phase-11-artwork-")); temporaryDirectories.push(root);
    await mkdir(path.join(root, "covers")); await writeFile(path.join(root, "covers", "safe.jpg"), "fixture");
    await expect(resolveArtworkSource(root, { cover_download: "covers/safe.jpg" }, ["cover_download"])).resolves.toBe(path.join(root, "covers", "safe.jpg"));
    await expect(resolveArtworkSource(root, { cover_download: "../private.jpg" }, ["cover_download"])).resolves.toBeNull();
  });

  it("recovers Release 263-style double-dot names and Release 377-style unique hash-prefix mismatches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "phase-12-artwork-")); temporaryDirectories.push(root);
    const release263 = "2e12f-awaken..jpg"; await writeFile(path.join(root, release263), "fixture");
    expect(await resolveArtworkSourceDetailed(root, { id: "263", cover_download: release263 }, ["cover_download"])).toMatchObject({ path: path.join(root, release263), rule: "EXACT_PATH" });
    const recovered377 = "a7719-mojibake-name.jpg"; await writeFile(path.join(root, recovered377), "fixture");
    expect(await resolveArtworkSourceDetailed(root, { id: "377", cover_download: "a7719-singolarità-euphoria.jpg" }, ["cover_download"])).toMatchObject({ path: path.join(root, recovered377), rule: "UNIQUE_HASH_PREFIX" });
    await writeFile(path.join(root, "a7719-second-candidate.jpg"), "fixture");
    await expect(resolveArtworkSourceDetailed(root, { id: "377", cover_download: "a7719-singolarità-euphoria.jpg" }, ["cover_download"])).resolves.toBeNull();
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
    expect(result.issues).toContainEqual(expect.objectContaining({ sourceLegacyId: 10, field: "cover_download", severity: "INFORMATIONAL", problem: "Optional Track artwork is absent." }));
  });

  it("does not warn for null or zero secondary Artists but warns for a genuinely invalid optional reference", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "phase-12-policy-")); temporaryDirectories.push(root);
    const result = await analyzeCatalogue("fixture", { artists: [{ id: "1", name: "Artist" }], tracks: [
      { id: "10", type: "track", title: "Null", artist_id: "1", secondary_artist_id: null, label: "STEYOYOKE", file_id: "a" },
      { id: "11", type: "track", title: "Zero", artist_id: "1", secondary_artist_id: "0", label: "STEYOYOKE", file_id: "b" },
      { id: "12", type: "track", title: "Missing", artist_id: "1", secondary_artist_id: "999", label: "STEYOYOKE", file_id: "c", itunes_link: "applemusichttps://invalid" },
    ], releases: [], releaseTracks: [] }, root);
    expect(result.issues.filter((issue) => issue.field === "secondary_artist_id" && issue.severity === "WARNING")).toHaveLength(1);
    expect(result.issues).toContainEqual(expect.objectContaining({ sourceLegacyId: 11, problem: "LEGACY_ZERO_SECONDARY_ARTIST", severity: "INFORMATIONAL" }));
    expect(result.issues).toContainEqual(expect.objectContaining({ sourceLegacyId: 12, field: "itunes_link", severity: "WARNING" }));
  });

  it("builds a stable, secret-free migration freeze manifest", () => {
    const summary = { sourceSha256: "a".repeat(64), source: { artists: 389 }, imported: { artists: 389 }, severity: { BLOCKER: 0, WARNING: 18 } };
    const comparison = { status: "PASS_WITH_CLASSIFIED_DIFFERENCES", classifications: { BUG: 0 } };
    const first = buildMigrationManifest(summary, comparison, "deadbeef"); const second = buildMigrationManifest(summary, comparison, "deadbeef");
    expect(second).toEqual(first); expect(JSON.stringify(first)).not.toMatch(/password|token|secret/i);
  });
});
