import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCatalogue, mapLabel, normalizeLegacyUrl, parseLegacyChapters, parseLegacyDate, parseLegacyDuration, resolveArtworkSource, resolveArtworkSourceDetailed } from "../../scripts/migration/analysis";
import { stableUuid } from "../../scripts/migration/identity";
import { extractTables, loadLegacySnapshot } from "../../scripts/migration/legacy-dump";
import { buildMigrationManifest } from "../../scripts/migration/manifest";
import { logicalComparisonFingerprint } from "../../scripts/migration/compare";
import { historicalImageId, historicalImageSourceIdentity } from "../../scripts/migration/media";
import { assertImportSuccess, migrationQualityStatus } from "../../scripts/migration/quality";
import { monotonicNextValue } from "../../scripts/migration/sequences";
import { selectMigrationScope } from "../../scripts/migration/scope";
import { APPROVED_SOURCE_SHA256, assertControlledImportGuards, classifyReleaseTracks, databaseTargetIdentity, externalAudioInvariantError, migrationRunId, storageTargetIdentity } from "../../scripts/migration/safety";

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

  it("creates stable historical image identities across different media roots", () => {
    const checksum = "a".repeat(64);
    const first = historicalImageSourceIdentity("/machine-a/media", "/machine-a/media/covers/example.jpg", checksum);
    const second = historicalImageSourceIdentity("/other/checkout/media", "/other/checkout/media/covers/example.jpg", checksum);
    expect(first).toBe("covers/example.jpg:" + checksum);
    expect(second).toBe(first);
    expect(historicalImageId(second)).toBe(historicalImageId(first));
    expect(historicalImageSourceIdentity("/machine-a/media", "/machine-a/media/other/example.jpg", checksum)).not.toBe(first);
  });

  it("calculates a reusable sample dependency closure", () => {
    const selected = selectMigrationScope({
      artists: [{ id: "4", name: "Primary" }, { id: "5", name: "Secondary" }, { id: "6", name: "Unused" }],
      tracks: [{ id: "10", type: "track", artist_id: "4" }, { id: "11", type: "podcast", artist_id: "5" }, { id: "12", type: "track", artist_id: "6" }],
      releases: [{ id: "20", artist_id: "5" }, { id: "21", artist_id: "6" }],
      releaseTracks: [{ release_id: "20", track_id: "10", priority: "0" }, { release_id: "21", track_id: "12", priority: "0" }],
    }, { podcasts: [11], releases: [20] });
    expect(selected.closure).toEqual({ artists: [4, 5], tracks: [10], podcasts: [11], releases: [20] });
    expect(selected.catalogue.releaseTracks).toEqual([{ release_id: "20", track_id: "10", priority: "0" }]);
  });

  it("never moves sequence allocation backwards", () => {
    expect(monotonicNextValue(399, 399, 400, false)).toBe(400);
    expect(monotonicNextValue(399, 450, 430, true)).toBe(451);
    expect(monotonicNextValue(399, 399, 500, true)).toBe(501);
  });

  it("fails strict reconciliation for bugs, unclassified, or unapproved migration data", () => {
    expect(migrationQualityStatus({ "EXPECTED NORMALIZATION": 1213, BUG: 0, UNCLASSIFIED: 0, "MIGRATION DATA ISSUE": 0 })).toBe("PASS_WITH_CLASSIFIED_DIFFERENCES");
    expect(migrationQualityStatus({ BUG: 1 })).toBe("FAIL");
    expect(migrationQualityStatus({ UNCLASSIFIED: 1 })).toBe("FAIL");
    expect(migrationQualityStatus({ "MIGRATION DATA ISSUE": 1 })).toBe("FAIL");
    expect(migrationQualityStatus({ "MIGRATION DATA ISSUE": 1 }, 1)).toBe("PASS_WITH_CLASSIFIED_DIFFERENCES");
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

  it("fingerprints reconciliation logically rather than by database result order", () => {
    const base = { sourceSha256: "a".repeat(64), compared: { artists: 1 }, classifications: { BUG: 0 }, status: "PASS_WITH_CLASSIFIED_DIFFERENCES" };
    const first = [{ classification: "EXPECTED NORMALIZATION" as const, entity: "artist", legacyId: 2, field: "name", source: " A ", canonical: "A" }, { classification: "EXPECTED NORMALIZATION" as const, entity: "artist", legacyId: 1, field: "name", source: " B ", canonical: "B" }];
    expect(logicalComparisonFingerprint({ ...base, differences: first })).toBe(logicalComparisonFingerprint({ ...base, differences: [...first].reverse() }));
  });

  it("binds controlled-import authorization to the actual source, resolved scope, DB endpoint, storage target, and write intent", () => {
    const databaseUrl = "postgresql://user:do-not-print@example.test:6543/catalogue?sslmode=require";
    const environment = {
      MEDIA_STORAGE_PROVIDER: "s3", MEDIA_S3_BUCKET: "catalogue-prod", MEDIA_S3_REGION: "eu-west-1", MEDIA_S3_ENDPOINT: "https://objects.example.test/private?token=secret", MEDIA_S3_PREFIX: "/migration/v1/",
      MIGRATION_CONFIRM_SOURCE_SHA: APPROVED_SOURCE_SHA256,
      MIGRATION_CONFIRM_SCOPE: "artists=4;tracks=1329;podcasts=1283;releases=47",
      MIGRATION_CONFIRM_TARGET: "example.test:6543/catalogue",
      MIGRATION_CONFIRM_STORAGE: "S3_COMPATIBLE:bucket=catalogue-prod;region=eu-west-1;endpoint=objects.example.test;prefix=migration/v1",
      MIGRATION_CONFIRM_WRITE: "import:example.test:6543/catalogue;scope=artists=4;tracks=1329;podcasts=1283;releases=47;storage=S3_COMPATIBLE:bucket=catalogue-prod;region=eu-west-1;endpoint=objects.example.test;prefix=migration/v1",
    };
    expect(assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl, environment })).toMatchObject({ databaseIdentity: "example.test:6543/catalogue" });
    expect(databaseTargetIdentity(databaseUrl)).not.toContain("user");
    expect(storageTargetIdentity(environment)).not.toContain("token");
    expect(() => assertControlledImportGuards({ actualSourceSha256: "f".repeat(64), scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl, environment })).toThrow(/loaded legacy snapshot/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: "full", databaseUrl, environment })).toThrow(/SCOPE/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl: databaseUrl.replace("example.test", "other.test"), environment })).toThrow(/TARGET/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl: databaseUrl.replace("/catalogue", "/other_database"), environment })).toThrow(/TARGET/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl, environment: { ...environment, MIGRATION_CONFIRM_STORAGE: undefined } })).toThrow(/STORAGE/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl, environment: { ...environment, MEDIA_S3_BUCKET: "wrong" } })).toThrow(/STORAGE/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl, environment: { ...environment, MEDIA_S3_PREFIX: "other-prefix" } })).toThrow(/STORAGE/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl, environment: { ...environment, MEDIA_STORAGE_PROVIDER: "local", MEDIA_STORAGE_ROOT: "/tmp/media" } })).toThrow(/STORAGE/);
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: environment.MIGRATION_CONFIRM_SCOPE, databaseUrl, environment: { ...environment, MIGRATION_CONFIRM_SOURCE_SHA: "0".repeat(64) } })).toThrow(/SOURCE_SHA/);
  });

  it("requires explicit full scope confirmation when selectors are omitted", () => {
    const databaseUrl = "postgresql://localhost/catalogue";
    const storage = storageTargetIdentity({ MEDIA_STORAGE_PROVIDER: "local", MEDIA_STORAGE_ROOT: "/tmp/catalogue" });
    const base = { MEDIA_STORAGE_PROVIDER: "local", MEDIA_STORAGE_ROOT: "/tmp/catalogue", MIGRATION_CONFIRM_SOURCE_SHA: APPROVED_SOURCE_SHA256, MIGRATION_CONFIRM_TARGET: "localhost:5432/catalogue", MIGRATION_CONFIRM_STORAGE: storage, MIGRATION_CONFIRM_WRITE: `import:localhost:5432/catalogue;scope=full;storage=${storage}` };
    expect(() => assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: "full", databaseUrl, environment: base })).toThrow(/SCOPE/);
    expect(assertControlledImportGuards({ actualSourceSha256: APPROVED_SOURCE_SHA256, scopeKey: "full", databaseUrl, environment: { ...base, MIGRATION_CONFIRM_SCOPE: "full" } })).toBeTruthy();
  });

  it("rejects changed snapshot contents even when the operator confirms the approved SHA", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "phase-3b-snapshot-")); temporaryDirectories.push(root);
    const snapshot = path.join(root, "changed.sql"); await writeFile(snapshot, "INSERT INTO `artists` (`id`,`name`) VALUES (1,'Changed');");
    const loaded = await loadLegacySnapshot(snapshot);
    const databaseUrl = "postgresql://localhost/catalogue"; const storage = storageTargetIdentity({ MEDIA_STORAGE_PROVIDER: "local", MEDIA_STORAGE_ROOT: root });
    const environment = { MEDIA_STORAGE_PROVIDER: "local", MEDIA_STORAGE_ROOT: root, MIGRATION_CONFIRM_SOURCE_SHA: APPROVED_SOURCE_SHA256, MIGRATION_CONFIRM_SCOPE: "full", MIGRATION_CONFIRM_TARGET: "localhost:5432/catalogue", MIGRATION_CONFIRM_STORAGE: storage, MIGRATION_CONFIRM_WRITE: `import:localhost:5432/catalogue;scope=full;storage=${storage}` };
    expect(loaded.sourceSha256).not.toBe(APPROVED_SOURCE_SHA256);
    expect(() => assertControlledImportGuards({ actualSourceSha256: loaded.sourceSha256, scopeKey: "full", databaseUrl, environment })).toThrow(/loaded legacy snapshot/);
  });

  it("uses generation-isolated deterministic run IDs", () => {
    const current = migrationRunId(APPROVED_SOURCE_SHA256, "full");
    expect(current).toBe(migrationRunId(APPROVED_SOURCE_SHA256, "full"));
    expect(current).not.toBe(stableUuid("migration-run", APPROVED_SOURCE_SHA256));
  });

  it("classifies ReleaseTracks once for plan/import parity", () => {
    const result = classifyReleaseTracks([
      { release_id: "1", track_id: "10", priority: "0" },
      { release_id: "1", track_id: "10", priority: "1" },
      { release_id: "1", track_id: "11", priority: "0" },
      { release_id: "1", track_id: "12", priority: "bad" },
      { release_id: "2", track_id: "10", priority: "0" },
    ], new Set([1]), new Set([10, 11, 12]));
    expect(result.accepted.map(({ trackLegacyId, position }) => ({ trackLegacyId, position }))).toEqual([{ trackLegacyId: 10, position: 0 }]);
    expect(result.rejected.map(({ reason }) => reason).sort()).toEqual(["DUPLICATE_POSITION", "DUPLICATE_TRACK", "INVALID_PRIORITY", "MISSING_RELEASE"].sort());
  });

  it("rejects any binary, variant, or job state on LEGACY_EXTERNAL audio", () => {
    const legacyAudioId = "audio-1";
    const base = { id: stableUuid("legacy-audio", legacyAudioId), kind: "AUDIO", provider: "LEGACY_EXTERNAL", status: "EXTERNAL", legacyAudioId, sourceStorageKey: null, compatibilityFilename: null, originalFilename: null, mimeType: null, byteSize: null, sha256Checksum: null, width: null, height: null, durationMs: null, failureReason: null, retiredAt: null, createdById: "00000000-0000-4000-8000-000000000011", variants: [], processingJob: null };
    expect(externalAudioInvariantError(base, legacyAudioId)).toBeNull();
    expect(externalAudioInvariantError({ ...base, sourceStorageKey: "audio/file.mp3" }, legacyAudioId)).toMatch(/sourceStorageKey/);
    expect(externalAudioInvariantError({ ...base, variants: [{}] }, legacyAudioId)).toMatch(/MediaVariants/);
    expect(externalAudioInvariantError({ ...base, processingJob: {} }, legacyAudioId)).toMatch(/MediaProcessingJob/);
  });

  it("keeps runs incomplete for every strict-gate failure class", () => {
    const passing = { scopeKey: "sample", sourceSha256: APPROVED_SOURCE_SHA256, analysisBlockers: 0, analysisWarnings: 0, blocked: { artists: 0, tracks: 0, podcasts: 0, releases: 0, releaseTracks: 0 }, expectedOmittedReleaseTracks: 0, failedCheckpoints: 0, conflictingCheckpoints: 0, incompleteImages: 0, incompleteImageJobs: 0, canonicalCountMismatches: [], comparison: { status: "PASS_WITH_CLASSIFIED_DIFFERENCES", classifications: { BUG: 0, UNCLASSIFIED: 0, "MIGRATION DATA ISSUE": 0, "COMPATIBILITY DIFFERENCE": 0 } } };
    expect(() => assertImportSuccess(passing)).not.toThrow();
    expect(() => assertImportSuccess({ ...passing, analysisBlockers: 1 })).toThrow(/BLOCKER/);
    expect(() => assertImportSuccess({ ...passing, failedCheckpoints: 1 })).toThrow(/FAILED/);
    expect(() => assertImportSuccess({ ...passing, conflictingCheckpoints: 1 })).toThrow(/CONFLICT/);
    expect(() => assertImportSuccess({ ...passing, incompleteImageJobs: 1 })).toThrow(/image job/);
    expect(() => assertImportSuccess({ ...passing, comparison: { status: "FAIL", classifications: { BUG: 1 } } })).toThrow(/comparison status/);
  });

  it("backfills historical MigrationRuns with per-row identities before adding uniqueness", async () => {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations/20260911193000_migration_run_checkpoints/migration.sql"), "utf8");
    expect(sql).toContain("'legacy:' || \"id\"::text");
    expect(sql).toContain('("sourceSha256", "scopeKey", "toolingVersion")');
    expect(sql).not.toContain('migration_runs_sourceSha256_scopeKey_key');
  });
});
