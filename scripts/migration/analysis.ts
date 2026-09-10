import path from "node:path";
import { stat } from "node:fs/promises";
import type { Analysis, LegacyCatalogue, MigrationIssueInput, ParsedChapter, RawRow } from "./types";

export const LABEL_MAP: Record<string, string> = {
  STEYOYOKE: "STEYOYOKE",
  STEYOYOKE_BLACK: "STEYOYOKE_BLACK",
  "STEYOYOKE BLACK": "STEYOYOKE_BLACK",
  INNER_SYMPHONY: "INNER_SYMPHONY",
  "INNER SYMPHONY": "INNER_SYMPHONY",
};

export function integer(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function mapLabel(value: string | null | undefined) {
  return LABEL_MAP[(value ?? "").trim().toUpperCase()] ?? null;
}

export function normalizeLegacyUrl(value: string | null | undefined) {
  const input = value?.trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.protocol = "https:";
    return url.toString();
  } catch { return null; }
}

export function parseLegacyDuration(value: string | null | undefined) {
  const input = (value ?? "").trim();
  if (!input) return null;
  const parts = input.split(":");
  if (parts.length !== 2 && parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const numbers = parts.map(Number);
  const [hours, minutes, seconds] = parts.length === 3 ? numbers : [0, ...numbers];
  if (seconds! > 59 || (parts.length === 3 && minutes! > 59)) return undefined;
  const result = (hours! * 3600 + minutes! * 60 + seconds!) * 1000;
  return Number.isSafeInteger(result) ? result : undefined;
}

export function parseLegacyDate(value: string | null | undefined) {
  const input = (value ?? "").trim();
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return undefined;
  const date = new Date(`${input}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== input ? undefined : date;
}

export function parseLegacyChapters(raw: string | null | undefined) {
  if (!(raw ?? "").trim()) return { classification: "PARSED CLEANLY" as const, rows: [] as ParsedChapter[], rejected: [] as string[] };
  const rows: ParsedChapter[] = []; const rejected: string[] = [];
  for (const sourceLine of raw!.split("\n")) {
    const line = sourceLine.replace(/\r$/, "").trim();
    if (!line) continue;
    const match = /^(.*?)\s+(\d+);(\d{1,3}):(\d{2})$/.exec(line);
    if (!match || Number(match[4]) > 59) { rejected.push(line); continue; }
    const separator = match[1]!.indexOf(" - ");
    if (separator < 1 || separator >= match[1]!.length - 3) { rejected.push(line); continue; }
    rows.push({ position: rows.length, artist: match[1]!.slice(0, separator).trim(), title: match[1]!.slice(separator + 3).trim(), legacyReference: match[2]!, durationMs: (Number(match[3]) * 60 + Number(match[4])) * 1000 });
  }
  return { classification: rejected.length ? rows.length ? "PARSED WITH WARNING" as const : "UNPARSEABLE" as const : "PARSED CLEANLY" as const, rows, rejected };
}

function safeEvidence(value: unknown) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/[\r\n\t]+/g, " ").slice(0, 200);
}

function issue(issues: MigrationIssueInput[], row: RawRow | null, sourceTable: string, field: string, severity: MigrationIssueInput["severity"], problem: string, proposedAction: string, evidence?: unknown) {
  issues.push({ sourceTable, sourceLegacyId: row ? integer(row.id) : null, field, severity, problem, evidence: safeEvidence(evidence), proposedAction });
}

function checkUrlFields(issues: MigrationIssueInput[], table: string, row: RawRow, fields: string[]) {
  for (const field of fields) {
    const value = row[field]?.trim(); if (!value) continue;
    try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); if (url.protocol === "http:") issue(issues, row, table, field, "COMPATIBILITY", "Legacy HTTP URL is normalized to HTTPS.", "Verify the HTTPS endpoint during reconciliation.", value); }
    catch { issue(issues, row, table, field, "WARNING", "Malformed or unsupported URL.", "Review and correct explicitly before production migration.", value); }
  }
}

function mediaCandidate(root: string, value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^https?:\/\/[^/]+\//i, "").replace(/^\/?assets\/uploads\/files\//, "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) return null;
  const target = path.resolve(root, normalized);
  return target.startsWith(`${path.resolve(root)}${path.sep}`) ? target : null;
}

export async function resolveArtworkSource(root: string, row: RawRow, fields: string[]) {
  for (const field of fields) {
    const direct = mediaCandidate(root, row[field]);
    const basename = row[field] ? mediaCandidate(root, path.basename(row[field]!)) : null;
    for (const candidate of [direct, basename]) {
      if (!candidate) continue;
      try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* try next local candidate */ }
    }
  }
  return null;
}

export async function analyzeCatalogue(sourceSha256: string, catalogue: LegacyCatalogue, mediaRoot: string): Promise<Analysis> {
  const issues: MigrationIssueInput[] = [];
  const artistIds = new Set<number>(); const trackIds = new Set<number>(); const releaseIds = new Set<number>();
  const normalizedNames = new Map<string, number[]>(); const chapters = new Map<number, ReturnType<typeof parseLegacyChapters>>();
  for (const row of catalogue.artists) {
    const id = integer(row.id); if (!id) issue(issues, row, "artists", "id", "BLOCKER", "Invalid Artist ID.", "Exclude until an explicit identity decision is made.", row.id); else artistIds.add(id);
    const name = row.name?.trim(); if (!name) issue(issues, row, "artists", "name", "BLOCKER", "Blank Artist name.", "Reconcile source row; do not invent an Artist.");
    else { const key = name.normalize("NFKC").toLocaleLowerCase(); normalizedNames.set(key, [...(normalizedNames.get(key) ?? []), id ?? -1]); }
    if (row.priority != null && (!/^-?\d+$/.test(row.priority) || Math.abs(Number(row.priority)) > 10_000)) issue(issues, row, "artists", "priority", "WARNING", "Unusual Artist priority.", "Review before mapping priority in a later phase.", row.priority);
    checkUrlFields(issues, "artists", row, ["facebook_url"]);
    if (row.image && !await resolveArtworkSource(mediaRoot, row, ["image"])) issue(issues, row, "artists", "image", "WARNING", "Artist artwork does not resolve in the local FTP snapshot.", "Import Artist without artwork and reconcile locally.", row.image);
  }
  for (const [name, ids] of normalizedNames) if (ids.length > 1) for (const id of ids) issue(issues, { id: String(id) }, "artists", "name", "WARNING", "Duplicate normalized Artist name.", "Preserve both legacy IDs and review merge policy.", `${name} (${ids.join(",")})`);

  const labels = new Map<string, number>();
  const contentRows = [...catalogue.tracks.map((row) => ["tracks", row] as const), ...catalogue.releases.map((row) => ["releases", row] as const)];
  for (const [, row] of contentRows) labels.set(row.label ?? "<NULL>", (labels.get(row.label ?? "<NULL>") ?? 0) + 1);

  for (const row of catalogue.tracks) {
    const id = integer(row.id); if (!id) issue(issues, row, "tracks", "id", "BLOCKER", "Invalid shared Track/Podcast ID.", "Exclude until reconciled.", row.id); else trackIds.add(id);
    if (!['track', 'podcast'].includes(row.type ?? "")) issue(issues, row, "tracks", "type", "BLOCKER", "Unknown Track type.", "Add an explicit approved mapping.", row.type);
    if (!row.title?.trim()) issue(issues, row, "tracks", "title", "BLOCKER", "Blank title.", "Reconcile source title.");
    for (const field of ["artist_id", "secondary_artist_id"]) { const value = row[field]; if (value && (!integer(value) || !artistIds.has(integer(value)!))) issue(issues, row, "tracks", field, field === "artist_id" ? "BLOCKER" : "WARNING", "Referenced Artist is missing.", "Reconcile the reference; do not create a fake Artist.", value); }
    if (integer(row.artist_id) && integer(row.artist_id) === integer(row.secondary_artist_id)) issue(issues, row, "tracks", "secondary_artist_id", "COMPATIBILITY", "Secondary Artist duplicates the primary Artist.", "Omit the redundant secondary reference canonically.", row.secondary_artist_id);
    if (!mapLabel(row.label)) issue(issues, row, "tracks", "label", "BLOCKER", "Unknown Label.", "Approve an explicit canonical mapping.", row.label);
    if (parseLegacyDuration(row.duration) === undefined) issue(issues, row, "tracks", "duration", "WARNING", "Malformed duration.", "Preserve null canonically and review source value.", row.duration);
    if (parseLegacyDate(row.date) === undefined) issue(issues, row, "tracks", "date", row.type === "podcast" ? "BLOCKER" : "WARNING", "Malformed date.", "Review before production migration.", row.date);
    checkUrlFields(issues, "tracks", row, ["itunes_link", "beatport_link", "web_link", "traxsource_link", "spotify_link", "soundcloud_link", "podcast_link"]);
    if (!await resolveArtworkSource(mediaRoot, row, ["cover_download", "cover_high", "cover_low", "cover_thumbnail_high", "cover_thumbnail_low"])) issue(issues, row, "tracks", "cover_download", row.type === "podcast" ? "BLOCKER" : "WARNING", "No usable local artwork reference resolved.", "Reconcile artwork from the local snapshot.", row.cover_download);
    if (!row.file_id?.trim()) issue(issues, row, "tracks", "file_id", row.type === "podcast" ? "BLOCKER" : "WARNING", "Missing historical audio ID.", "Reconcile before production migration.");
    else issue(issues, row, "tracks", "file_id", "INFORMATIONAL", "Audio binary is unresolved because S3 access is prohibited.", "Preserve exact ID as a LEGACY_EXTERNAL reference and materialize later.", row.file_id);
    if (row.type === "podcast" && id) {
      const parsed = parseLegacyChapters(row.artist_feature_times); chapters.set(id, parsed);
      for (const rejected of parsed.rejected) issue(issues, row, "tracks", "artist_feature_times", "WARNING", "Podcast chapter line is unparseable and was not forced into canonical chapters.", "Review raw source evidence during cleanup.", rejected);
    }
  }

  for (const row of catalogue.releases) {
    const id = integer(row.id); if (!id) issue(issues, row, "releases", "id", "BLOCKER", "Invalid Release ID.", "Exclude until reconciled.", row.id); else releaseIds.add(id);
    if (!row.title?.trim()) issue(issues, row, "releases", "title", "BLOCKER", "Blank Release title.", "Reconcile source title.");
    for (const field of ["artist_id", "secondary_artist_id"]) { const value = row[field]; if (value && (!integer(value) || !artistIds.has(integer(value)!))) issue(issues, row, "releases", field, field === "artist_id" ? "BLOCKER" : "WARNING", "Referenced Artist is missing.", "Reconcile reference without fabricating an Artist.", value); }
    if (integer(row.artist_id) && integer(row.artist_id) === integer(row.secondary_artist_id)) issue(issues, row, "releases", "secondary_artist_id", "COMPATIBILITY", "Secondary Artist duplicates the primary Artist.", "Omit the redundant secondary reference canonically.", row.secondary_artist_id);
    if (!mapLabel(row.label)) issue(issues, row, "releases", "label", "BLOCKER", "Unknown Label.", "Approve an explicit canonical mapping.", row.label);
    if (!(parseLegacyDate(row.date) instanceof Date)) issue(issues, row, "releases", "date", "BLOCKER", "Missing or malformed Release date.", "Reconcile the date before publication.", row.date);
    checkUrlFields(issues, "releases", row, ["itunes_link", "beatport_link", "web_link", "traxsource_link", "spotify_link", "soundcloud_link"]);
    if (!await resolveArtworkSource(mediaRoot, row, ["cover_download", "cover_high", "cover_low", "cover_thumbnail_high", "cover_thumbnail_low"])) issue(issues, row, "releases", "cover_download", "BLOCKER", "No usable local Release artwork resolved.", "Reconcile artwork from the local snapshot.", row.cover_download);
  }

  const positions = new Map<number, number[]>(); const relationKeys = new Set<string>();
  for (const row of catalogue.releaseTracks) {
    const releaseId = integer(row.release_id); const trackId = integer(row.track_id); const position = row.priority && /^-?\d+$/.test(row.priority) ? Number(row.priority) : null;
    const pseudo = { id: releaseId ? String(releaseId) : null } as RawRow;
    if (!releaseId || !releaseIds.has(releaseId) || !trackId || !trackIds.has(trackId)) issue(issues, pseudo, "release_tracks", "relation", "WARNING", "Dangling ReleaseTrack relation.", "Omit relation; do not create fake content.", `${row.release_id ?? "NULL"}:${row.track_id ?? "NULL"}`);
    if (position === null || position < 0) issue(issues, pseudo, "release_tracks", "priority", "WARNING", "Invalid ReleaseTrack priority.", "Omit relation pending explicit ordering decision.", row.priority);
    const key = `${releaseId}:${trackId}`; if (relationKeys.has(key)) issue(issues, pseudo, "release_tracks", "relation", "WARNING", "Duplicate ReleaseTrack relation.", "Keep one deterministic relation.", key); else relationKeys.add(key);
    if (releaseId && position !== null) positions.set(releaseId, [...(positions.get(releaseId) ?? []), position]);
  }
  for (const [releaseId, values] of positions) {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    if (sorted.some((value, index) => value !== index)) issue(issues, { id: String(releaseId) }, "release_tracks", "priority", "WARNING", "ReleaseTrack positions are not a contiguous zero-based sequence.", "Preserve valid ordering then normalize positions deterministically.", sorted.join(","));
  }

  return {
    sourceSha256, catalogue, issues, chapters,
    labels: [...labels].map(([legacyValue, count]) => ({ legacyValue, count, canonicalValue: mapLabel(legacyValue) })).sort((a, b) => b.count - a.count),
    counts: { artists: catalogue.artists.length, tracks: catalogue.tracks.filter((row) => row.type === "track").length, podcasts: catalogue.tracks.filter((row) => row.type === "podcast").length, releases: catalogue.releases.length, releaseTracks: catalogue.releaseTracks.length },
  };
}
