import { mkdir, readFile, writeFile } from "node:fs/promises";
import { analyzeCatalogue } from "./analysis";
import { compareRehearsal } from "./compare";
import { LEGACY_MEDIA_ROOT, LEGACY_SNAPSHOT, REHEARSAL_OUTPUT_ROOT, REHEARSAL_REPORT_PATH } from "./config";
import { runRehearsal } from "./importer";
import { loadLegacySnapshot } from "./legacy-dump";

async function analyze() {
  const loaded = await loadLegacySnapshot(LEGACY_SNAPSHOT); const result = await analyzeCatalogue(loaded.sourceSha256, loaded.catalogue, LEGACY_MEDIA_ROOT);
  const severity = Object.fromEntries(["BLOCKER", "WARNING", "COMPATIBILITY", "INFORMATIONAL"].map((level) => [level, result.issues.filter((issue) => issue.severity === level).length]));
  const summary = { sourceSha256: result.sourceSha256, counts: result.counts, labels: result.labels, severity, chapterParsing: Object.fromEntries(["PARSED CLEANLY", "PARSED WITH WARNING", "UNPARSEABLE"].map((classification) => [classification, [...result.chapters.values()].filter((chapter) => chapter.classification === classification).length])) };
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
const result = command === "analyze" ? await analyze() : command === "rehearse-import" ? await runRehearsal().then(({ summary }) => summary) : command === "compare" ? await compare() : command === "report" ? await report() : null;
if (!result) throw new Error("Use analyze, rehearse-import, compare, or report.");
console.log(JSON.stringify(result, null, 2));
