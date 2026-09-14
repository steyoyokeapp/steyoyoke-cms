import type { MediaAsset, PodcastChapterRevision, PodcastEpisodeRevision } from "@/generated/prisma/client";
import { isLegacyAuthorized, legacyUnauthorized } from "@/modules/artists/legacy";
import { formatLegacyDuration } from "@/modules/tracks/duration";
import { getPublishedPodcastForLegacy, listPublishedPodcastsForLegacy, listPublishedPodcastArtistNames } from "@/modules/podcasts/service";
import { LegacyAudioSerializer, LegacyMediaSerializer } from "@/modules/media/legacy";

export function legacyPodcastTitle(title: string) {
  return title.startsWith("Steyoyoke ") ? title.slice(10) : title;
}

export function legacyPodcastLabel(legacyValue: string) {
  return legacyValue.split(/_+/).filter(Boolean).join(" ");
}

export function legacyPodcastDate(date: Date) {
  const year = date.getUTCFullYear(); const month = String(date.getUTCMonth() + 1).padStart(2, "0"); const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function serializeLegacyPodcast(revision: PodcastEpisodeRevision & { chapters: PodcastChapterRevision[]; artworkAsset?: MediaAsset | null; audioAsset?: MediaAsset | null }, legacyId: number) {
  const covers = LegacyMediaSerializer.covers(revision.artworkAsset);
  return {
    id: String(legacyId), title: legacyPodcastTitle(revision.title), description: null, artist: null,
    artist_id: String(revision.primaryArtistLegacyId), secondary_artist_id: revision.secondaryArtistLegacyId === null ? null : String(revision.secondaryArtistLegacyId),
    date: legacyPodcastDate(revision.episodeDate), duration: formatLegacyDuration(revision.durationMs), label: legacyPodcastLabel(revision.labelLegacyValue),
    artist_feature_times: revision.chapters.map((chapter) => ({ duration: formatLegacyDuration(chapter.durationMs), title: chapter.title, id: chapter.legacyReference ?? "", artist: chapter.artist })),
    ...covers,
    podcast_link: null, podcast_link_title: null, genre: null, bpm: null, type: "podcast", low_mp3: null, high_mp3: null,
    itunes_link: null, beatport_link: null, web_link: null, traxsource_link: null, spotify_link: null, soundcloud_link: null,
    file_id: LegacyAudioSerializer.podcast(revision.audioAsset), artist_name: revision.primaryArtistName,
  };
}

type Source = { legacyId: number; publishedRevision: (PodcastEpisodeRevision & { chapters: PodcastChapterRevision[]; artworkAsset?: MediaAsset | null; audioAsset?: MediaAsset | null }) | null };
function envelope(episodes: Source[], pagination?: { total: number; limit: string; offset: string }) {
  return {
    ...(pagination ? { total_rows: pagination.total } : {}),
    tracks: episodes.map((episode) => {
      if (!episode.publishedRevision) throw new Error("Published Podcast is missing its revision."); return serializeLegacyPodcast(episode.publishedRevision, episode.legacyId);
    }),
    ...(pagination ? { limit: pagination.limit, offset: pagination.offset } : {}),
    base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files",
  };
}

function paginationValue(raw: string | null, fallback: number, name: string) {
  const value = raw === null ? fallback : Number(raw); if (!Number.isSafeInteger(value) || value < 0 || (name === "limit" && value === 0)) throw new Error(`Invalid ${name}.`); return name === "limit" ? Math.min(value, 500) : value;
}

export async function handleLegacyPodcastRequest(request: Request, legacyId?: number) {
  if (!isLegacyAuthorized(request)) return legacyUnauthorized(); const params = new URL(request.url).searchParams;
  if (params.get("filter") !== "tracks" || params.get("type") !== "podcast") return Response.json({ error: "Unsupported Podcast request." }, { status: 400 });
  if (legacyId !== undefined) {
    const episode = await getPublishedPodcastForLegacy(legacyId); return Response.json(envelope(episode ? [episode] : []), { headers: { "Cache-Control": "private, no-store" } });
  }
  const paginated = params.has("limit") || params.has("offset");
  try {
    if (!paginated) { const result = await listPublishedPodcastsForLegacy(); return Response.json(envelope(result.episodes), { headers: { "Cache-Control": "private, no-store" } }); }
    const limit = paginationValue(params.get("limit"), 50, "limit"); const offset = paginationValue(params.get("offset"), 0, "offset"); const result = await listPublishedPodcastsForLegacy(limit, offset);
    return Response.json(envelope(result.episodes, { total: result.total, limit: String(limit), offset: String(offset) }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid pagination." }, { status: 400 }); }
}

export async function handleLegacyPodcastArtistsRequest(request: Request) {
  if (!isLegacyAuthorized(request)) return legacyUnauthorized();
  return Response.json({ allpodcastartist: await listPublishedPodcastArtistNames() }, { headers: { "Cache-Control": "private, no-store" } });
}
