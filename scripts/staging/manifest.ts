import "dotenv/config";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { migrationClient } from "../migration/database";
import { NORMALIZATION_RULES_VERSION } from "../migration/policy";

const databaseUrl = process.env.STAGING_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/steyoyoke_cms_staging") throw new Error("STAGING_DATABASE_URL must target steyoyoke_cms_staging.");
if (process.env.STAGING_CONFIRM_NON_PRODUCTION !== "steyoyoke_cms_staging") throw new Error("Explicit non-production confirmation is required.");

const outputRoot = path.join(process.cwd(), ".staging-migration");
const quality = JSON.parse(await readFile(path.join(outputRoot, "quality-report.json"), "utf8"));
const migrations = (await readdir(path.join(process.cwd(), "prisma/migrations"))).sort();
const db = migrationClient(databaseUrl);
try {
  const [artists, tracks, podcasts, releases, releaseTracks, chapters, images, audio, artistRevisions, trackRevisions, podcastRevisions, releaseRevisions, revisionTracks] = await Promise.all([
    db.artist.count(), db.track.count(), db.podcastEpisode.count(), db.release.count(), db.releaseTrack.count(), db.podcastChapter.count(),
    db.mediaAsset.count({ where: { kind: "IMAGE" } }), db.mediaAsset.count({ where: { kind: "AUDIO" } }),
    db.artistRevision.count(), db.trackRevision.count(), db.podcastEpisodeRevision.count(), db.releaseRevision.count(), db.releaseRevisionTrack.count(),
  ]);
  const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceSqlSha256: quality.summary.sourceSha256,
    sourceCounts: quality.summary.source,
    migrationCodeCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim(),
    stagingSchemaVersion: migrations.at(-1),
    importCounts: { artists, tracks, podcasts, releases, releaseTracks, podcastChapters: chapters, imageAssets: images, historicalAudioReferences: audio, revisions: artistRevisions + trackRevisions + podcastRevisions + releaseRevisions, releaseRevisionTracks: revisionTracks },
    warningCounts: quality.summary.severity,
    normalizationRulesVersion: NORMALIZATION_RULES_VERSION,
    compatibilityHttpComparison: process.env.STAGING_HTTP_COMPARISON_STATUS || "PENDING_EXTERNAL_STAGING",
    mediaImportCounts: { images, audioReferences: audio },
    deploymentIdentifier: process.env.STAGING_DEPLOYMENT_ID || "PENDING_EXTERNAL_STAGING",
  };
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(outputRoot, "freeze-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await db.$disconnect();
}
