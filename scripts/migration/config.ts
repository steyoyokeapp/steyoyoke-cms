import path from "node:path";

export const LEGACY_ROOT = path.resolve(process.cwd(), "../steyoyoke-backend-main/beta.steyoyoke.com");
export const LEGACY_SNAPSHOT = process.env.LEGACY_SNAPSHOT_PATH || path.join(LEGACY_ROOT, "steyoyok_dbapp.sql");
export const LEGACY_MEDIA_ROOT = process.env.LEGACY_MEDIA_ROOT || path.join(LEGACY_ROOT, "assets/uploads/files");
export const REHEARSAL_OUTPUT_ROOT = process.env.MIGRATION_OUTPUT_ROOT || path.join(process.cwd(), ".migration-rehearsal");
export const REHEARSAL_STORAGE_ROOT = path.join(REHEARSAL_OUTPUT_ROOT, "storage");
export const REHEARSAL_REPORT_PATH = path.join(REHEARSAL_OUTPUT_ROOT, "quality-report.json");
export const REHEARSAL_DATABASE = "steyoyoke_cms_migration_rehearsal";

export function rehearsalDatabaseUrl() {
  const source = process.env.MIGRATION_REHEARSAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!source) throw new Error("DATABASE_URL or MIGRATION_REHEARSAL_DATABASE_URL is required.");
  const url = new URL(source);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("Migration rehearsal is restricted to a local PostgreSQL host.");
  url.pathname = `/${REHEARSAL_DATABASE}`;
  if (url.pathname !== `/${REHEARSAL_DATABASE}`) throw new Error("Unsafe rehearsal database name.");
  return url.toString();
}

