/** Read-only inventory. This command never detaches, retires or deletes anything. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";

const output = process.argv[2];
if (!output) throw new Error("Usage: tsx scripts/artists/media-inventory.ts <report.json>");
const values = dotenv.parse(await readFile(resolve(".env.local")));
const connectionString = values.PRODUCTION_READONLY_DATABASE_URL;
if (!connectionString) throw new Error("Existing PRODUCTION_READONLY_DATABASE_URL is required");
const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
await client.connect();
try {
  const role = (await client.query("SELECT current_user AS role")).rows[0].role;
  if (role !== "steyoyoke_inventory_ro") throw new Error("Inventory requires the dedicated read-only role");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const counts = (await client.query(`SELECT
    (SELECT count(*)::int FROM artists) AS artists,
    (SELECT count(*)::int FROM artists WHERE "imageAssetId" IS NOT NULL) AS "artistsWithMedia",
    (SELECT count(*)::int FROM artist_revisions WHERE "imageAssetId" IS NOT NULL) AS "revisionsWithMedia",
    (SELECT count(*)::int FROM media_audit_logs WHERE metadata->>'contentType' = 'ARTIST') AS "artistMediaAuditEntries"`)).rows[0];
  const candidates = (await client.query(`SELECT m.id, m.provider, m.status, m."sourceStorageKey", m."compatibilityFilename",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'variantKey', v."variantKey", 'storageKey', v."storageKey")) FROM media_variants v WHERE v."mediaAssetId" = m.id), '[]'::jsonb) AS variants
    FROM media_assets m WHERE m.id IN (
      SELECT "imageAssetId" FROM artists WHERE "imageAssetId" IS NOT NULL
      UNION SELECT "imageAssetId" FROM artist_revisions WHERE "imageAssetId" IS NOT NULL
      UNION SELECT "mediaAssetId" FROM media_audit_logs WHERE metadata->>'contentType' = 'ARTIST' AND "mediaAssetId" IS NOT NULL)
    ORDER BY m.id`)).rows;
  const foreignKeys = (await client.query(`SELECT conrelid::regclass::text AS "table", a.attname AS "column"
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    WHERE c.contype='f' AND c.confrelid='media_assets'::regclass`)).rows;
  const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const assets = [];
  for (const candidate of candidates) {
    const references = [];
    for (const fk of foreignKeys) {
      if (["media_variants", "media_processing_jobs", "media_audit_logs"].includes(fk.table)) continue;
      const count = (await client.query(`SELECT count(*)::int AS count FROM ${fk.table.split('.').map(quote).join('.')} WHERE ${quote(fk.column)}=$1`, [candidate.id])).rows[0].count;
      if (count) references.push({ table: fk.table, column: fk.column, count });
    }
    const shared = references.some(r => r.table !== "artists");
    // Historical revisions are protected even when all references belong to Artists.
    // A zero/shared-free FK count alone cannot prove external legacy binary use absent.
    assets.push({ ...candidate, references, referenceCount: references.reduce((n, r) => n + r.count, 0),
      artistOnly: references.length > 0 && references.every(r => ["artists", "artist_revisions"].includes(r.table)),
      classification: shared ? "SHARED_DO_NOT_DELETE" : "UNCERTAIN_DO_NOT_DELETE",
      reason: shared ? "Revision or non-Artist reference must be preserved" : "Requires proof of compatibility/storage ownership before lifecycle deletion" });
  }
  await client.query("COMMIT");
  const report = { generatedAt: new Date().toISOString(), readOnly: true, role, counts, foreignKeys, assets, removedAssets: 0, removedObjects: 0 };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ counts, candidateAssets: assets.length, output: resolve(output) }));
} finally { await client.end(); }
