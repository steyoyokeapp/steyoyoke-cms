export type DifferenceClassification = "EXPECTED NORMALIZATION" | "COMPATIBILITY DIFFERENCE" | "MIGRATION DATA ISSUE" | "UNCLASSIFIED" | "BUG";

export function migrationQualityStatus(counts: Partial<Record<DifferenceClassification, number>>, allowlistedMigrationDataIssues = 0) {
  const unexplainedMigrationData = Math.max(0, (counts["MIGRATION DATA ISSUE"] ?? 0) - allowlistedMigrationDataIssues);
  return (counts.BUG ?? 0) === 0 && (counts.UNCLASSIFIED ?? 0) === 0 && unexplainedMigrationData === 0
    ? "PASS_WITH_CLASSIFIED_DIFFERENCES" as const
    : "FAIL" as const;
}

export function assertImportSuccess(input: {
  scopeKey: string;
  sourceSha256: string;
  analysisBlockers: number;
  analysisWarnings: number;
  blocked: { artists: number; tracks: number; podcasts: number; releases: number; releaseTracks: number };
  expectedOmittedReleaseTracks: number;
  failedCheckpoints: number;
  conflictingCheckpoints: number;
  incompleteImages: number;
  incompleteImageJobs: number;
  canonicalCountMismatches: string[];
  comparison: { status: string; classifications: Partial<Record<DifferenceClassification, number>> };
}) {
  const failures: string[] = [];
  if (input.analysisBlockers) failures.push(`${input.analysisBlockers} source analysis BLOCKER(s)`);
  for (const kind of ["artists", "tracks", "podcasts", "releases"] as const) if (input.blocked[kind]) failures.push(`${input.blocked[kind]} blocked ${kind}`);
  if (input.blocked.releaseTracks !== input.expectedOmittedReleaseTracks) failures.push("ReleaseTrack accepted-count reconciliation failed");
  if (input.failedCheckpoints) failures.push(`${input.failedCheckpoints} FAILED checkpoint(s)`);
  if (input.conflictingCheckpoints) failures.push(`${input.conflictingCheckpoints} CONFLICT checkpoint(s)`);
  if (input.incompleteImages) failures.push(`${input.incompleteImages} incomplete required image(s)`);
  if (input.incompleteImageJobs) failures.push(`${input.incompleteImageJobs} incomplete required image job(s)`);
  failures.push(...input.canonicalCountMismatches);
  if (input.comparison.status !== "PASS_WITH_CLASSIFIED_DIFFERENCES") failures.push(`comparison status is ${input.comparison.status}`);
  if ((input.comparison.classifications["COMPATIBILITY DIFFERENCE"] ?? 0) !== 0) failures.push("compatibility differences are nonzero");
  if (input.scopeKey === "full" && input.sourceSha256 === "180d16528b61f4520cdce86dcc793953dc747804e61d5e61dd019b71a6e48141") {
    if (input.analysisWarnings !== 18) failures.push("full-catalogue warning baseline differs from 18");
    if ((input.comparison.classifications["EXPECTED NORMALIZATION"] ?? 0) !== 1213) failures.push("full-catalogue expected-normalization baseline differs from 1213");
  }
  if (failures.length) throw new Error(`Strict migration success gate failed: ${failures.join("; ")}.`);
}
