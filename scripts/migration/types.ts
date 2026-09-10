export type RawValue = string | null;
export type RawRow = Record<string, RawValue>;

export type LegacyCatalogue = {
  artists: RawRow[];
  tracks: RawRow[];
  releases: RawRow[];
  releaseTracks: RawRow[];
};

export type IssueSeverity = "BLOCKER" | "WARNING" | "COMPATIBILITY" | "INFORMATIONAL";
export type MigrationIssueInput = {
  sourceTable: string;
  sourceLegacyId: number | null;
  field: string;
  severity: IssueSeverity;
  problem: string;
  evidence: string | null;
  proposedAction: string;
};

export type ParsedChapter = {
  position: number;
  artist: string;
  title: string;
  legacyReference: string | null;
  durationMs: number | null;
};

export type Analysis = {
  sourceSha256: string;
  catalogue: LegacyCatalogue;
  issues: MigrationIssueInput[];
  labels: Array<{ legacyValue: string; count: number; canonicalValue: string | null }>;
  chapters: Map<number, { classification: "PARSED CLEANLY" | "PARSED WITH WARNING" | "UNPARSEABLE"; rows: ParsedChapter[] }>;
  counts: { artists: number; tracks: number; podcasts: number; releases: number; releaseTracks: number };
};

