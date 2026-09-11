import type { PrismaClient } from "../../src/generated/prisma/client";

export async function generateRollbackManifest(db: PrismaClient, runId: string) {
  const run = await db.migrationRun.findUniqueOrThrow({ where: { id: runId }, include: { records: true } });
  const metadata = (record: typeof run.records[number]) => record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? record.metadata : {};
  const ownedRecords = (type: string) => run.records.filter((record) => record.entityType === type && record.canonicalId && metadata(record).createdByRun === true);
  const ids = (type: string) => ownedRecords(type).map((record) => record.canonicalId!);
  const auditWhere = { metadata: { path: ["migrationRunId"], equals: runId } } as const;
  const [mediaAuditLogs, artistAuditLogs, trackAuditLogs, podcastAuditLogs, releaseAuditLogs] = await Promise.all([
    db.mediaAuditLog.findMany({ where: auditWhere, select: { id: true } }), db.auditLog.findMany({ where: auditWhere, select: { id: true } }),
    db.trackAuditLog.findMany({ where: auditWhere, select: { id: true } }), db.podcastAuditLog.findMany({ where: auditWhere, select: { id: true } }),
    db.releaseAuditLog.findMany({ where: auditWhere, select: { id: true } }),
  ]);
  const actor = ownedRecords("ACTOR")[0] ?? null;
  const labels = ownedRecords("LABEL");
  const sourceStorageKeys = run.records.filter((record) => record.entityType === "IMAGE" && metadata(record).sourceCreatedByRun === true).map((record) => metadata(record).sourceStorageKey).filter((value): value is string => typeof value === "string");
  const variantStorageKeys = run.records.filter((record) => record.entityType === "IMAGE_VARIANT" && metadata(record).storageCreatedByRun === true).map((record) => metadata(record).storageKey).filter((value): value is string => typeof value === "string");
  return {
    manifestVersion: 1, dryRunOnly: true, migrationRun: { id: run.id, sourceSha256: run.sourceSha256, scopeKey: run.scopeKey },
    owned: {
      artists: ids("ARTIST"), artistRevisions: ids("ARTIST_REVISION"), tracks: ids("TRACK"), trackRevisions: ids("TRACK_REVISION"),
      podcasts: ids("PODCAST"), podcastRevisions: ids("PODCAST_REVISION"), podcastChapters: ids("PODCAST_CHAPTER"), podcastRevisionChapters: ids("PODCAST_REVISION_CHAPTER"),
      releases: ids("RELEASE"), releaseTracks: ids("RELEASE_TRACK"), releaseRevisions: ids("RELEASE_REVISION"), releaseRevisionTracks: ids("RELEASE_REVISION_TRACK"),
      mediaAssets: [...ids("IMAGE"), ...ids("AUDIO")], mediaVariants: ids("IMAGE_VARIANT"), mediaProcessingJobs: ids("IMAGE_JOB"),
      auditLogs: [...mediaAuditLogs, ...artistAuditLogs, ...trackAuditLogs, ...podcastAuditLogs, ...releaseAuditLogs].map(({ id }) => id),
      actor, labels,
      storageKeys: [...new Set([...sourceStorageKeys, ...variantStorageKeys])],
    },
    sequencePolicy: "Never move legacy sequences backwards during rollback.",
    executable: false,
  };
}
