import { createHash } from "node:crypto";

export function stableUuid(scope: string, identity: string | number) {
  const bytes = createHash("sha256").update(`steyoyoke-phase-11:${scope}:${identity}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function migrationSlug(name: string, legacyId: number) {
  const stem = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 180) || "artist";
  return `${stem}-${legacyId}`;
}

