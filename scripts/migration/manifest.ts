import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { REHEARSAL_OUTPUT_ROOT, REHEARSAL_REPORT_PATH } from "./config";
import { NORMALIZATION_RULES, NORMALIZATION_RULES_VERSION } from "./policy";

type Summary = { sourceSha256: string; source: Record<string, number>; imported: Record<string, number>; severity: Record<string, number> };
type Comparison = { status: string; classifications: Record<string, number> };

export function buildMigrationManifest(summary: Summary, comparison: Comparison, migrationCodeCommit: string) {
  return {
    manifestVersion: 1,
    sourceSqlSha256: summary.sourceSha256,
    migrationCodeCommit,
    normalizationRulesVersion: NORMALIZATION_RULES_VERSION,
    normalizationRules: [...NORMALIZATION_RULES],
    sourceCounts: summary.source,
    importCounts: summary.imported,
    blockerCount: summary.severity.BLOCKER ?? 0,
    warningCount: summary.severity.WARNING ?? 0,
    compatibilityComparison: { status: comparison.status, ...comparison.classifications },
  };
}

export async function writeMigrationManifest() {
  const quality = JSON.parse(await readFile(REHEARSAL_REPORT_PATH, "utf8")) as { summary: Summary };
  const comparison = JSON.parse(await readFile(path.join(REHEARSAL_OUTPUT_ROOT, "comparison.json"), "utf8")) as Comparison;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  const manifest = buildMigrationManifest(quality.summary, comparison, commit);
  await writeFile(path.join(REHEARSAL_OUTPUT_ROOT, "freeze-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
