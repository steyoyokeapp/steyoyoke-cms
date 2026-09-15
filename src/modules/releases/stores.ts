export const releaseStores = [["spotifyUrl", "Spotify", "spotify"], ["appleMusicUrl", "Apple Music", "applemusic"], ["bandcampUrl", "Bandcamp", "bandcamp"], ["beatportUrl", "Beatport", "beatport"], ["traxsourceUrl", "Traxsource", "traxsource"]] as const;
export type ReleaseStoreLinks = Record<(typeof releaseStores)[number][0], string>;
export function defaultReleaseStores(catalogue: string): ReleaseStoreLinks {
  const code = encodeURIComponent(catalogue.trim().toLowerCase());
  return Object.fromEntries(releaseStores.map(([key, , path]) => [key, code ? `https://syykrec.com/${code}/${path}` : ""])) as ReleaseStoreLinks;
}
export function updateReleaseStores(current: ReleaseStoreLinks, previous: string, next: string, manual: ReadonlySet<string>): ReleaseStoreLinks {
  const before = defaultReleaseStores(previous), after = defaultReleaseStores(next);
  return Object.fromEntries(releaseStores.map(([key]) => [key, !current[key] || (!manual.has(key) && current[key] === before[key]) ? after[key] : current[key]])) as ReleaseStoreLinks;
}
