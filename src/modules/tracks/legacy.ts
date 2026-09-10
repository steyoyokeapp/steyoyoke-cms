import type { MediaAsset, TrackRevision } from "@/generated/prisma/client";
import { isLegacyAuthorized, legacyUnauthorized } from "@/modules/artists/legacy";
import { formatLegacyDuration } from "@/modules/tracks/duration";
import { getPublishedTrackForLegacy, listPublishedTracksForLegacy } from "@/modules/tracks/service";
import { LegacyAudioSerializer, LegacyMediaSerializer } from "@/modules/media/legacy";

export function serializeLegacyTrack(revision: TrackRevision & { artworkAsset?: MediaAsset | null; audioAsset?: MediaAsset | null }, legacyId: number) {
  const covers = LegacyMediaSerializer.covers(revision.artworkAsset);
  return {
    id: String(legacyId),
    title: revision.title,
    description: null,
    artist: null,
    artist_id: String(revision.primaryArtistLegacyId),
    secondary_artist_id: revision.secondaryArtistLegacyId === null ? null : String(revision.secondaryArtistLegacyId),
    date: null,
    duration: formatLegacyDuration(revision.durationMs),
    label: revision.labelLegacyValue,
    artist_feature_times: null,
    ...covers,
    podcast_link: null,
    podcast_link_title: null,
    genre: null,
    bpm: null,
    type: "track",
    low_mp3: null,
    high_mp3: null,
    itunes_link: revision.appleMusicUrl,
    beatport_link: revision.beatportUrl,
    web_link: revision.bandcampUrl,
    traxsource_link: revision.traxsourceUrl,
    spotify_link: revision.spotifyUrl,
    soundcloud_link: revision.soundcloudUrl,
    file_id: LegacyAudioSerializer.track(revision.audioAsset),
    artist_name: revision.primaryArtistName,
  };
}

function envelope(tracks: Array<{ legacyId: number; publishedRevision: (TrackRevision & { artworkAsset?: MediaAsset | null; audioAsset?: MediaAsset | null }) | null }>, pagination?: { total: number; limit: string; offset: string }) {
  return {
    ...(pagination ? { total_rows: pagination.total } : {}),
    tracks: tracks.map((track) => {
      if (!track.publishedRevision) throw new Error("Published Track is missing its revision.");
      return serializeLegacyTrack(track.publishedRevision, track.legacyId);
    }),
    ...(pagination ? { limit: pagination.limit, offset: pagination.offset } : {}),
    base_cover_folder: "/1440/",
    main_cover_folder: "/assets/uploads/files",
  };
}

function paginationValue(raw: string | null, fallback: number, name: string) {
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || (name === "limit" && value === 0)) throw new Error(`Invalid ${name}.`);
  return name === "limit" ? Math.min(value, 500) : value;
}

export async function handleLegacyTrackRequest(request: Request, legacyId?: number) {
  if (!isLegacyAuthorized(request)) return legacyUnauthorized();
  const params = new URL(request.url).searchParams;
  if (params.get("filter") !== "tracks" || params.get("type") !== "track") return Response.json({ error: "Unsupported Track request." }, { status: 400 });
  if (legacyId !== undefined) {
    const track = await getPublishedTrackForLegacy(legacyId);
    return Response.json(envelope(track ? [track] : []), { headers: { "Cache-Control": "private, no-store" } });
  }
  const paginated = params.has("limit") || params.has("offset");
  try {
    if (!paginated) {
      const result = await listPublishedTracksForLegacy();
      return Response.json(envelope(result.tracks), { headers: { "Cache-Control": "private, no-store" } });
    }
    const limit = paginationValue(params.get("limit"), 50, "limit");
    const offset = paginationValue(params.get("offset"), 0, "offset");
    const result = await listPublishedTracksForLegacy(limit, offset);
    return Response.json(envelope(result.tracks, { total: result.total, limit: String(limit), offset: String(offset) }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid pagination." }, { status: 400 });
  }
}
