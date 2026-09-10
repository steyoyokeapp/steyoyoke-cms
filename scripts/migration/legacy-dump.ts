import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LegacyCatalogue, RawRow, RawValue } from "./types";

const ALLOWED_TABLES = new Set(["artists", "tracks", "releases", "release_tracks"]);

function unescapeMysql(value: string) {
  return value.replace(/\\([0bnrtZ\\'\"])/g, (_, escaped: string) => ({
    "0": "\0", b: "\b", n: "\n", r: "\r", t: "\t", Z: "\x1a", "\\": "\\", "'": "'", '"': '"',
  })[escaped] ?? escaped);
}

function parseValues(input: string): RawValue[][] {
  const rows: RawValue[][] = [];
  let row: RawValue[] | null = null;
  let token = ""; let quoted = false; let escaped = false; let wasQuoted = false;
  const finish = () => {
    const raw = token.trim();
    row!.push(wasQuoted ? unescapeMysql(token) : raw.toUpperCase() === "NULL" ? null : raw);
    token = ""; wasQuoted = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (escaped) { token += `\\${char}`; escaped = false; }
      else if (char === "\\") escaped = true;
      else if (char === "'") quoted = false;
      else token += char;
      continue;
    }
    if (char === "'") { if (!token.trim()) token = ""; quoted = true; wasQuoted = true; continue; }
    if (char === "(") { row = []; token = ""; wasQuoted = false; continue; }
    if (!row) continue;
    if (char === ",") { finish(); continue; }
    if (char === ")") { finish(); rows.push(row); row = null; continue; }
    token += char;
  }
  if (quoted || row) throw new Error("Unterminated legacy INSERT value list.");
  return rows;
}

function statementEnd(sql: string, start: number) {
  let quoted = false; let escaped = false;
  for (let i = start; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "'") quoted = false;
    } else if (char === "'") quoted = true;
    else if (char === ";") return i;
  }
  throw new Error("Unterminated legacy INSERT statement.");
}

export function extractTables(sql: string): LegacyCatalogue {
  const result: Record<string, RawRow[]> = { artists: [], tracks: [], releases: [], release_tracks: [] };
  const header = /INSERT INTO `([^`]+)` \(([^)]+)\) VALUES\s*/g;
  for (const match of sql.matchAll(header)) {
    const table = match[1]!;
    if (!ALLOWED_TABLES.has(table)) continue;
    const columns = [...match[2]!.matchAll(/`([^`]+)`/g)].map((column) => column[1]!);
    const valueStart = match.index! + match[0].length;
    const end = statementEnd(sql, valueStart);
    for (const values of parseValues(sql.slice(valueStart, end))) {
      if (values.length !== columns.length) throw new Error(`Column mismatch in ${table}.`);
      result[table]!.push(Object.fromEntries(columns.map((column, index) => [column, values[index]!])));
    }
  }
  return { artists: result.artists!, tracks: result.tracks!, releases: result.releases!, releaseTracks: result.release_tracks! };
}

export async function loadLegacySnapshot(snapshotPath: string) {
  const bytes = await readFile(snapshotPath);
  return { sourceSha256: createHash("sha256").update(bytes).digest("hex"), catalogue: extractTables(bytes.toString("utf8")) };
}
