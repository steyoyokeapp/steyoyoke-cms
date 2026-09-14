// Shared, dependency-free contract for browser, API and worker.
export const TRACK_AUDIO_MAX_BYTES = 512 * 1024 * 1024;
export const TRACK_AUDIO_MAX_SECONDS = 30 * 60;
export const trackStores = [
  ["spotifyUrl", "Spotify", "spotify"], ["appleMusicUrl", "Apple Music", "applemusic"],
  ["bandcampUrl", "Bandcamp", "bandcamp"], ["beatportUrl", "Beatport", "beatport"],
  ["traxsourceUrl", "Traxsource", "traxsource"],
] as const;
export function trackAudioFilename(filename: string) {
  const match = /^([A-Za-z0-9_-]{1,190})\.(mp3|wav)$/i.exec(filename);
  if (!match) throw new Error("Choose a WAV or MP3 with a filename containing only letters, numbers, underscores or hyphens.");
  const identity = match[1]!.replace(/-high$/i, "");
  if (!identity || /-high$/i.test(identity)) throw new Error("Remove the repeated -high suffix from the filename.");
  const catalogueMatch = /^((?:SYYK|IS)[A-Za-z0-9-]*\d[A-Za-z0-9-]*)_(\d+)$/i.exec(identity);
  const catalogue = catalogueMatch && Number(catalogueMatch[2]) > 0 ? catalogueMatch[1]!.toLowerCase() : null;
  return { identity, key: `${identity}-high.mp3`, extension: match[2]!.toLowerCase(), catalogue };
}
export function defaultTrackStores(filename: string) {
  const { catalogue } = trackAudioFilename(filename);
  return catalogue ? Object.fromEntries(trackStores.map(([field, , store]) => [field, `https://syykrec.com/${catalogue}/${store}`])) : {};
}
