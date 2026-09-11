import { integer } from "./analysis";
import type { LegacyCatalogue, RawRow } from "./types";

export type MigrationScope = "full" | {
  artists?: number[];
  tracks?: number[];
  podcasts?: number[];
  releases?: number[];
};

const uniqueSorted = (values: number[] = []) => [...new Set(values)].sort((a, b) => a - b);

export function migrationScopeKey(scope: MigrationScope) {
  if (scope === "full") return "full";
  return [
    `artists=${uniqueSorted(scope.artists).join(",")}`,
    `tracks=${uniqueSorted(scope.tracks).join(",")}`,
    `podcasts=${uniqueSorted(scope.podcasts).join(",")}`,
    `releases=${uniqueSorted(scope.releases).join(",")}`,
  ].join(";");
}

function byId(rows: RawRow[]) { return new Map(rows.map((row) => [integer(row.id), row])); }

export function selectMigrationScope(catalogue: LegacyCatalogue, scope: MigrationScope) {
  if (scope === "full") return {
    catalogue,
    scopeKey: "full",
    closure: {
      artists: catalogue.artists.map((row) => integer(row.id)!).filter(Boolean),
      tracks: catalogue.tracks.filter((row) => row.type === "track").map((row) => integer(row.id)!).filter(Boolean),
      podcasts: catalogue.tracks.filter((row) => row.type === "podcast").map((row) => integer(row.id)!).filter(Boolean),
      releases: catalogue.releases.map((row) => integer(row.id)!).filter(Boolean),
    },
  };

  const artistRows = byId(catalogue.artists);
  const contentRows = byId(catalogue.tracks);
  const releaseRows = byId(catalogue.releases);
  const artistIds = new Set(uniqueSorted(scope.artists));
  const trackIds = new Set(uniqueSorted(scope.tracks));
  const podcastIds = new Set(uniqueSorted(scope.podcasts));
  const releaseIds = new Set(uniqueSorted(scope.releases));

  const requireRow = (rows: Map<number | null, RawRow>, id: number, kind: string) => {
    const row = rows.get(id);
    if (!row) throw new Error(`Selected ${kind} legacy ID ${id} does not exist in the approved source.`);
    return row;
  };
  for (const id of trackIds) if (requireRow(contentRows, id, "Track").type !== "track") throw new Error(`Selected Track legacy ID ${id} is not a normal Track.`);
  for (const id of podcastIds) if (requireRow(contentRows, id, "Podcast").type !== "podcast") throw new Error(`Selected Podcast legacy ID ${id} is not a Podcast.`);
  for (const id of releaseIds) requireRow(releaseRows, id, "Release");
  for (const id of artistIds) requireRow(artistRows, id, "Artist");

  const relations = catalogue.releaseTracks.filter((row) => releaseIds.has(integer(row.release_id)!));
  for (const relation of relations) {
    const id = integer(relation.track_id);
    if (id && contentRows.get(id)?.type === "track") trackIds.add(id);
  }
  for (const id of [...trackIds, ...podcastIds]) {
    const row = requireRow(contentRows, id, "content");
    const primary = integer(row.artist_id); const secondary = integer(row.secondary_artist_id);
    if (primary) artistIds.add(primary); if (secondary) artistIds.add(secondary);
  }
  for (const id of releaseIds) {
    const row = requireRow(releaseRows, id, "Release");
    const primary = integer(row.artist_id); const secondary = integer(row.secondary_artist_id);
    if (primary) artistIds.add(primary); if (secondary) artistIds.add(secondary);
  }

  const selected: LegacyCatalogue = {
    artists: catalogue.artists.filter((row) => artistIds.has(integer(row.id)!)),
    tracks: catalogue.tracks.filter((row) => row.type === "track" ? trackIds.has(integer(row.id)!) : podcastIds.has(integer(row.id)!)),
    releases: catalogue.releases.filter((row) => releaseIds.has(integer(row.id)!)),
    releaseTracks: relations,
  };
  return {
    catalogue: selected,
    scopeKey: migrationScopeKey(scope),
    closure: { artists: uniqueSorted([...artistIds]), tracks: uniqueSorted([...trackIds]), podcasts: uniqueSorted([...podcastIds]), releases: uniqueSorted([...releaseIds]) },
  };
}
