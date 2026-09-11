import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { stableUuid } from "./identity";
import { MIGRATION_TOOLING_VERSION, migrationRunId } from "./safety";

export type MigrationDb = PrismaClient | Prisma.TransactionClient;

export type MigrationRecordStatus = "PLANNED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CONFLICT";

export class MigrationConflictError extends Error {
  constructor(message: string) { super(message); this.name = "MigrationConflictError"; }
}

export async function ensureMigrationRun(db: PrismaClient, sourceSha256: string, scopeKey: string) {
  const id = migrationRunId(sourceSha256, scopeKey);
  const existing = await db.migrationRun.findUnique({ where: { id } });
  if (existing) {
    if (existing.sourceSha256 !== sourceSha256 || existing.scopeKey !== scopeKey || existing.toolingVersion !== MIGRATION_TOOLING_VERSION) throw new MigrationConflictError(`Migration run ${id} conflicts with its deterministic source identity.`);
    return existing;
  }
  const byGeneration = await db.migrationRun.findUnique({ where: { sourceSha256_scopeKey_toolingVersion: { sourceSha256, scopeKey, toolingVersion: MIGRATION_TOOLING_VERSION } } });
  if (byGeneration) throw new MigrationConflictError(`Production-safe migration identity ${sourceSha256}/${scopeKey}/${MIGRATION_TOOLING_VERSION} is already owned by unexpected run ${byGeneration.id}.`);
  return db.migrationRun.create({ data: { id, sourceSha256, scopeKey, toolingVersion: MIGRATION_TOOLING_VERSION } });
}

export async function checkpoint(db: MigrationDb, runId: string, entityType: string, sourceIdentity: string, values: {
  canonicalId?: string | null; stage: string; status: MigrationRecordStatus; metadata?: Prisma.InputJsonValue; error?: string | null;
}) {
  const id = stableUuid("migration-record", `${runId}:${entityType}:${sourceIdentity}`);
  const previous = await db.migrationRecord.findUnique({ where: { runId_entityType_sourceIdentity: { runId, entityType, sourceIdentity } } });
  const priorMetadata = previous?.metadata && typeof previous.metadata === "object" && !Array.isArray(previous.metadata) ? previous.metadata : {};
  const nextMetadata = values.metadata && typeof values.metadata === "object" && !Array.isArray(values.metadata)
    ? { ...priorMetadata, ...values.metadata } as Record<string, Prisma.InputJsonValue>
    : values.metadata ?? previous?.metadata ?? undefined;
  if (nextMetadata && typeof nextMetadata === "object" && !Array.isArray(nextMetadata)) {
    for (const key of ["createdByRun", "publishedByRun", "sourceCreatedByRun", "storageCreatedByRun"]) if (priorMetadata[key] === true) nextMetadata[key] = true;
  }
  return db.migrationRecord.upsert({
    where: { runId_entityType_sourceIdentity: { runId, entityType, sourceIdentity } },
    create: { id, runId, entityType, sourceIdentity, canonicalId: values.canonicalId, stage: values.stage, status: values.status, metadata: nextMetadata, error: values.error },
    update: { canonicalId: values.canonicalId, stage: values.stage, status: values.status, metadata: nextMetadata, error: values.error },
  });
}

export async function conflict(db: PrismaClient, runId: string, entityType: string, sourceIdentity: string, message: string, canonicalId?: string | null): Promise<never> {
  await checkpoint(db, runId, entityType, sourceIdentity, { canonicalId, stage: "CONFLICT", status: "CONFLICT", error: message });
  throw new MigrationConflictError(message);
}
