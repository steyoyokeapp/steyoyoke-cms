import { mkdir, readFile, writeFile } from "node:fs/promises";
import { analyzeCatalogue, classifyRejectedChapterLine } from "./analysis";
import { compareRehearsal } from "./compare";
import { LEGACY_MEDIA_ROOT, LEGACY_SNAPSHOT, REHEARSAL_OUTPUT_ROOT, REHEARSAL_REPORT_PATH } from "./config";
import { executeImport, runRehearsal, runStagingImport } from "./importer";
import { loadLegacySnapshot } from "./legacy-dump";
import { writeMigrationManifest } from "./manifest";
import { buildMigrationPlan } from "./plan";
import { generateRollbackManifest } from "./rollback";
import { migrationClient } from "./database";
import { createStorageProvider } from "../../src/modules/media/storage";
import type { MigrationScope } from "./scope";
import { selectMigrationScope } from "./scope";
import { assertControlledImportGuards } from "./safety";

function selectedScope(): MigrationScope {
  const values = (name: string) => process.argv.filter((argument) => argument.startsWith(`--${name}=`)).flatMap((argument) => argument.slice(name.length + 3).split(",")).filter(Boolean).map(Number);
  const scope = { artists: values("artist"), tracks: values("track"), podcasts: values("podcast"), releases: values("release") };
  if (![...scope.artists, ...scope.tracks, ...scope.podcasts, ...scope.releases].length) return "full";
  if ([...scope.artists, ...scope.tracks, ...scope.podcasts, ...scope.releases].some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("Migration selectors must be positive integer legacy IDs.");
  return scope;
}

async function rollbackPlan(runId: string | undefined) {
  if (!runId) throw new Error("rollback-plan requires a migration run UUID.");
  const url = process.env.MIGRATION_PLAN_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_PLAN_DATABASE_URL is required for rollback-plan.");
  const db = migrationClient(url, 1); let transactionStarted = false;
  try {
    await db.$executeRawUnsafe("BEGIN READ ONLY"); transactionStarted = true;
    const state = await db.$queryRawUnsafe<Array<{ transaction_read_only: string }>>("SHOW transaction_read_only");
    if (state[0]?.transaction_read_only !== "on") throw new Error("Rollback-plan database transaction is not read-only.");
    return await generateRollbackManifest(db, runId);
  } finally {
    if (transactionStarted) await db.$executeRawUnsafe("ROLLBACK");
    await db.$disconnect();
  }
}

async function controlledImport(scope: MigrationScope) {
  const url = process.env.MIGRATION_TARGET_DATABASE_URL; if (!url) throw new Error("MIGRATION_TARGET_DATABASE_URL is required.");
  const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT);
  const selected = selectMigrationScope(loaded.catalogue, scope);
  assertControlledImportGuards({ actualSourceSha256: loaded.sourceSha256, scopeKey: selected.scopeKey, databaseUrl: url, environment: process.env });
  return executeImport(url, createStorageProvider(process.env), null, scope, { expectedSourceSha256: loaded.sourceSha256 }).then(({ summary }) => summary);
}

async function analyze() {
  const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT); const result = await analyzeCatalogue(loaded.sourceSha256, loaded.catalogue, LEGACY_MEDIA_ROOT);
  const severity = Object.fromEntries(["BLOCKER", "WARNING", "COMPATIBILITY", "INFORMATIONAL"].map((level) => [level, result.issues.filter((issue) => issue.severity === level).length]));
  const rejected = [...result.chapters.values()].flatMap((chapter) => chapter.rejected);
  const summary = { sourceSha256: result.sourceSha256, counts: result.counts, labels: result.labels, severity, chapterParsing: Object.fromEntries(["PARSED CLEANLY", "PARSED WITH WARNING", "UNPARSEABLE"].map((classification) => [classification, [...result.chapters.values()].filter((chapter) => chapter.classification === classification).length])), chapterReview: Object.fromEntries([...new Set(rejected.map(classifyRejectedChapterLine))].sort().map((classification) => [classification, rejected.filter((line) => classifyRejectedChapterLine(line) === classification).length])) };
  await mkdir(REHEARSAL_OUTPUT_ROOT, { recursive: true, mode: 0o700 }); await writeFile(REHEARSAL_REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), summary, issues: result.issues }, null, 2), { mode: 0o600 }); return summary;
}

async function report() {
  const quality = JSON.parse(await readFile(REHEARSAL_REPORT_PATH, "utf8"));
  let comparison = null; try { comparison = JSON.parse(await readFile(`${REHEARSAL_OUTPUT_ROOT}/comparison.json`, "utf8")); } catch { /* comparison is optional before import */ }
  return { quality: quality.summary, comparison: comparison ? { compared: comparison.compared, classifications: comparison.classifications, status: comparison.status } : null };
}

async function compare() {
  const { compared, classifications, status } = await compareRehearsal();
  if (status === "FAIL") process.exitCode = 1;
  return { compared, classifications, status };
}

const command = process.argv[2];
const scope = selectedScope();
const result = command === "analyze" ? await analyze() : command === "plan" ? await buildMigrationPlan(scope, process.env.MIGRATION_PLAN_DATABASE_URL) : command === "rehearse-import" ? await runRehearsal(scope).then(({ summary }) => summary) : command === "controlled-import" ? await controlledImport(scope) : command === "staging-import" ? await runStagingImport().then(({ summary }) => summary) : command === "compare" ? await compare() : command === "report" ? await report() : command === "manifest" ? await writeMigrationManifest() : command === "rollback-plan" ? await rollbackPlan(process.argv[3]) : null;
if (!result) throw new Error("Use analyze, plan, rehearse-import, controlled-import, staging-import, compare, report, manifest, or rollback-plan.");
console.log(JSON.stringify(result, null, 2));
