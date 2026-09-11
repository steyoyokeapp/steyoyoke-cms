import path from "node:path";
import type { RawRow } from "./types";
import { integer } from "./analysis";
import { stableUuid } from "./identity";

export const APPROVED_SOURCE_SHA256 = "180d16528b61f4520cdce86dcc793953dc747804e61d5e61dd019b71a6e48141";
export const MIGRATION_TOOLING_VERSION = "phase2-production-safe-v1";
export const MIGRATION_ACTOR_ID = "00000000-0000-4000-8000-000000000011";
export const MIGRATION_ACTOR = { id: MIGRATION_ACTOR_ID, name: "Catalogue Migration Rehearsal", email: "migration-rehearsal@local.invalid", role: "ADMIN" } as const;
export const CANONICAL_LABELS = [
  { id: "00000000-0000-4000-8000-000000000101", name: "Steyoyoke", slug: "steyoyoke", legacyValue: "STEYOYOKE" },
  { id: "00000000-0000-4000-8000-000000000102", name: "Steyoyoke Black", slug: "steyoyoke-black", legacyValue: "STEYOYOKE_BLACK" },
  { id: "00000000-0000-4000-8000-000000000103", name: "Inner Symphony", slug: "inner-symphony", legacyValue: "INNER_SYMPHONY" },
] as const;

export function migrationRunId(sourceSha256: string, scopeKey: string) {
  return stableUuid("migration-run-v2", `${MIGRATION_TOOLING_VERSION}:${sourceSha256}:${scopeKey}`);
}

export function databaseTargetIdentity(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) throw new Error("Migration target URL must include a hostname and database name.");
  const port = url.port || (url.protocol === "postgres:" || url.protocol === "postgresql:" ? "5432" : "default");
  return `${url.hostname.toLowerCase()}:${port}/${database}`;
}

export function storageTargetIdentity(environment: Record<string, string | undefined>) {
  const provider = environment.MEDIA_STORAGE_PROVIDER?.trim().toLowerCase() || "local";
  if (provider === "local") {
    const root = path.resolve(environment.MEDIA_STORAGE_ROOT?.trim() || path.join(process.cwd(), ".local-storage"));
    return `LOCAL:root=${root}`;
  }
  if (provider !== "s3") throw new Error("MEDIA_STORAGE_PROVIDER must be local or s3.");
  const bucket = environment.MEDIA_S3_BUCKET?.trim();
  if (!bucket) throw new Error("MEDIA_S3_BUCKET is required when MEDIA_STORAGE_PROVIDER=s3.");
  const region = environment.MEDIA_S3_REGION?.trim() || "us-east-1";
  const prefix = environment.MEDIA_S3_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "<none>";
  const endpointValue = environment.MEDIA_S3_ENDPOINT?.trim();
  const endpoint = endpointValue ? new URL(endpointValue).host.toLowerCase() : "aws-default";
  return `S3_COMPATIBLE:bucket=${bucket};region=${region};endpoint=${endpoint};prefix=${prefix}`;
}

export function assertControlledImportGuards(input: {
  actualSourceSha256: string;
  scopeKey: string;
  databaseUrl: string;
  environment: Record<string, string | undefined>;
}) {
  const { actualSourceSha256, scopeKey, databaseUrl, environment } = input;
  if (actualSourceSha256 !== APPROVED_SOURCE_SHA256) throw new Error("The loaded legacy snapshot SHA-256 does not match the approved source.");
  if (environment.MIGRATION_CONFIRM_SOURCE_SHA !== actualSourceSha256) throw new Error("MIGRATION_CONFIRM_SOURCE_SHA must exactly match the loaded snapshot SHA-256.");
  if (environment.MIGRATION_CONFIRM_SCOPE !== scopeKey) throw new Error(`MIGRATION_CONFIRM_SCOPE must exactly match the resolved scopeKey: ${scopeKey}`);
  const databaseIdentity = databaseTargetIdentity(databaseUrl);
  if (environment.MIGRATION_CONFIRM_TARGET !== databaseIdentity) throw new Error(`MIGRATION_CONFIRM_TARGET must exactly match the sanitized database target: ${databaseIdentity}`);
  const storageIdentity = storageTargetIdentity(environment);
  if (environment.MIGRATION_CONFIRM_STORAGE !== storageIdentity) throw new Error(`MIGRATION_CONFIRM_STORAGE must exactly match the sanitized storage target: ${storageIdentity}`);
  const writeIntent = `import:${databaseIdentity};scope=${scopeKey};storage=${storageIdentity}`;
  if (environment.MIGRATION_CONFIRM_WRITE !== writeIntent) throw new Error("MIGRATION_CONFIRM_WRITE must exactly match the resolved database, scope, and storage write intent.");
  return { databaseIdentity, storageIdentity, writeIntent };
}

export function matchesExpectedRecord(actual: Record<string, unknown>, expected: Record<string, unknown>, ignoredKeys: readonly string[] = ["status"]) {
  return Object.entries(expected).every(([key, value]) => {
    if (ignoredKeys.includes(key)) return true;
    const candidate = actual[key];
    if (candidate instanceof Date && value instanceof Date) return candidate.valueOf() === value.valueOf();
    return candidate === value;
  });
}

type ExternalAudioCandidate = Record<string, unknown> & { variants?: unknown[]; processingJob?: unknown };

export function externalAudioInvariantError(asset: ExternalAudioCandidate | null, legacyAudioId: string) {
  const expectedId = stableUuid("legacy-audio", legacyAudioId);
  if (!asset) return "asset is absent";
  const expected: Record<string, unknown> = {
    id: expectedId, kind: "AUDIO", provider: "LEGACY_EXTERNAL", status: "EXTERNAL", legacyAudioId,
    sourceStorageKey: null, compatibilityFilename: null, originalFilename: null, mimeType: null,
    byteSize: null, sha256Checksum: null, width: null, height: null, durationMs: null,
    failureReason: null, retiredAt: null, createdById: MIGRATION_ACTOR_ID,
  };
  for (const [key, value] of Object.entries(expected)) if (asset[key] !== value) return `${key} differs from the historical external-audio invariant`;
  if ((asset.variants?.length ?? 0) !== 0) return "generated MediaVariants are present";
  if (asset.processingJob) return "a MediaProcessingJob is present";
  return null;
}

export type AcceptedReleaseTrack = { releaseLegacyId: number; trackLegacyId: number; position: number; row: RawRow };
export type RejectedReleaseTrack = { row: RawRow; reason: "MISSING_RELEASE" | "MISSING_TRACK" | "INVALID_PRIORITY" | "DUPLICATE_TRACK" | "DUPLICATE_POSITION" };

export function classifyReleaseTracks(rows: RawRow[], allowedReleaseIds: ReadonlySet<number>, allowedTrackIds: ReadonlySet<number>) {
  const accepted: AcceptedReleaseTrack[] = [];
  const rejected: RejectedReleaseTrack[] = [];
  const groups = Map.groupBy(rows, (row) => integer(row.release_id) ?? -1);
  for (const [releaseLegacyId, group] of groups) {
    if (!allowedReleaseIds.has(releaseLegacyId)) { for (const row of group) rejected.push({ row, reason: "MISSING_RELEASE" }); continue; }
    const candidates: AcceptedReleaseTrack[] = [];
    for (const row of group) {
      const trackLegacyId = integer(row.track_id);
      if (!trackLegacyId || !allowedTrackIds.has(trackLegacyId)) { rejected.push({ row, reason: "MISSING_TRACK" }); continue; }
      if (!row.priority || !/^\d+$/.test(row.priority)) { rejected.push({ row, reason: "INVALID_PRIORITY" }); continue; }
      candidates.push({ releaseLegacyId, trackLegacyId, position: Number(row.priority), row });
    }
    candidates.sort((a, b) => a.position - b.position);
    const tracks = new Set<number>(); const positions = new Set<number>();
    for (const candidate of candidates) {
      if (tracks.has(candidate.trackLegacyId)) { rejected.push({ row: candidate.row, reason: "DUPLICATE_TRACK" }); continue; }
      if (positions.has(candidate.position)) { rejected.push({ row: candidate.row, reason: "DUPLICATE_POSITION" }); continue; }
      tracks.add(candidate.trackLegacyId); positions.add(candidate.position); accepted.push(candidate);
    }
  }
  return { accepted, rejected };
}
