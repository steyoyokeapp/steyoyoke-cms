import type { ReleaseRevision, TrackRevision } from "@/generated/prisma/client";
import { isLegacyAuthorized, legacyUnauthorized } from "@/modules/artists/legacy";
import { getPublishedReleaseForLegacy, listLegacyReleaseArtists, listLegacyReleaseTitles, listLegacyReleaseTrackTitles, listPublishedReleasesForLegacy, queryPublishedReleaseFilter } from "@/modules/releases/legacy-query";
import { serializeLegacyTrack } from "@/modules/tracks/legacy";

export type ReleaseAliasMode = "paginated" | "unpaginated" | "single" | "complete" | "filter";
type LegacyReleaseSnapshot = Pick<ReleaseRevision, "title" | "primaryArtistLegacyId" | "primaryArtistName" | "secondaryArtistLegacyId" | "secondaryArtistName" | "releaseDate" | "labelLegacyValue" | "bandcampUrl" | "appleMusicUrl" | "beatportUrl" | "traxsourceUrl" | "spotifyUrl" | "soundcloudUrl">;

export function legacyReleaseTitle(title: string) { return title.startsWith("Steyoyoke ") ? title.slice(10) : title; }
export function legacyReleaseLabel(legacyValue: string) { return legacyValue.split(/_+/).filter(Boolean).join(" "); }
export function legacyReleaseDate(date: Date) {
  const year = date.getUTCFullYear(); const month = String(date.getUTCMonth() + 1).padStart(2, "0"); const day = String(date.getUTCDate()).padStart(2, "0"); return `${year}-${month}-${day}`;
}

export function serializeLegacyRelease(revision: LegacyReleaseSnapshot, legacyId: number, mode: ReleaseAliasMode, titleTracks?: Array<{ track_title: string; id: string }>) {
  const aliases = mode === "paginated" || mode === "complete"
    ? { artist_name: revision.primaryArtistName, secondary_artist_name: revision.secondaryArtistName }
    : mode === "unpaginated" || mode === "filter"
      ? { artist_name: revision.primaryArtistName }
      : {};
  return {
    id: String(legacyId), title: legacyReleaseTitle(revision.title), artist_id: String(revision.primaryArtistLegacyId),
    secondary_artist_id: revision.secondaryArtistLegacyId === null ? null : String(revision.secondaryArtistLegacyId),
    date: legacyReleaseDate(revision.releaseDate), label: legacyReleaseLabel(revision.labelLegacyValue),
    cover_download: null, cover_thumbnail_low: null, cover_thumbnail_high: null, cover_low: null, cover_high: null,
    web_link: revision.bandcampUrl, itunes_link: revision.appleMusicUrl, beatport_link: revision.beatportUrl,
    traxsource_link: revision.traxsourceUrl, spotify_link: revision.spotifyUrl, soundcloud_link: revision.soundcloudUrl,
    ...aliases, ...(titleTracks ? { title_track: titleTracks } : {}),
  };
}

export function serializeLegacyReleaseCompleteTrack(revision: TrackRevision, legacyId: number) {
  const track = { ...serializeLegacyTrack(revision, legacyId) } as Omit<ReturnType<typeof serializeLegacyTrack>, "artist_name"> & { artist_name?: string };
  delete track.artist_name;
  return { ...track, title: legacyReleaseTitle(revision.title), label: legacyReleaseLabel(revision.labelLegacyValue), artist_track_name: revision.primaryArtistName, secondary_artist_track_name: revision.secondaryArtistName };
}

type Source = Awaited<ReturnType<typeof getPublishedReleaseForLegacy>>;
function releaseEnvelope(releases: NonNullable<Source>[], mode: ReleaseAliasMode, pagination?: { total: number; limit: string; offset: string }) {
  return {
    ...(pagination ? { total_rows: pagination.total } : {}),
    releases: releases.map((release) => {
      if (!release.publishedRevision) throw new Error("Published Release is missing its revision.");
      return serializeLegacyRelease(release.publishedRevision, release.legacyId, mode);
    }),
    ...(pagination ? { limit: pagination.limit, offset: pagination.offset } : {}),
    base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files",
  };
}

function paginationValue(raw: string | null, fallback: number, name: string) {
  const value = raw === null ? fallback : Number(raw); if (!Number.isSafeInteger(value) || value < 0 || (name === "limit" && value === 0)) throw new Error(`Invalid ${name}.`); return name === "limit" ? Math.min(value, 500) : value;
}

const responseHeaders = { "Cache-Control": "private, no-store" };

export async function handleLegacyReleaseRequest(request: Request, legacyId?: number) {
  if (!isLegacyAuthorized(request)) return legacyUnauthorized(); const params = new URL(request.url).searchParams; const filter = params.get("filter");
  try {
    if (filter === "releases") {
      if (legacyId !== undefined) { const release = await getPublishedReleaseForLegacy(legacyId); return Response.json(releaseEnvelope(release ? [release] : [], "single"), { headers: responseHeaders }); }
      const paginated = params.has("limit") || params.has("offset"); const limit = paginationValue(params.get("limit"), 50, "limit"); const offset = paginationValue(params.get("offset"), 0, "offset");
      const result = await listPublishedReleasesForLegacy(paginated ? limit : undefined, paginated ? offset : 0);
      return Response.json(releaseEnvelope(result.releases, paginated ? "paginated" : "unpaginated", paginated ? { total: result.total, limit: String(limit), offset: String(offset) } : undefined), { headers: responseHeaders });
    }
    if (filter === "releasecomplete" && legacyId !== undefined) {
      const release = await getPublishedReleaseForLegacy(legacyId); const revision = release?.publishedRevision;
      return Response.json({ releasecomplete: revision ? { "0": serializeLegacyRelease(revision, release.legacyId, "complete"), tracks: revision.tracks.map(({ trackRevision }) => serializeLegacyReleaseCompleteTrack(trackRevision, trackRevision.track.legacyId)) } : { tracks: [] }, base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" }, { headers: responseHeaders });
    }
    if (filter === "releasefilter" && legacyId === undefined) {
      const paginated = params.has("limit") || params.has("offset"); const limit = paginationValue(params.get("limit"), 50, "limit"); const offset = paginationValue(params.get("offset"), 0, "offset");
      const result = await queryPublishedReleaseFilter({ artist: params.get("artist") || undefined, releaseTitle: params.get("releasetl") || undefined, label: params.get("label") || undefined, trackTitle: params.get("tracktl") || undefined, limit, offset, paginated });
      return Response.json({ ...(paginated ? { total_rows: result.total } : {}), releasefilter: result.releases.map((release) => serializeLegacyRelease(release.publishedRevision!, release.legacyId, "filter", release.legacyTitleTracks)), ...(paginated ? { limit: String(limit), offset: String(offset) } : {}), base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" }, { headers: responseHeaders });
    }
    if (legacyId === undefined && filter === "allreleaseartist") return Response.json({ allreleaseartist: await listLegacyReleaseArtists(), base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" }, { headers: responseHeaders });
    if (legacyId === undefined && filter === "alltitlerelease") return Response.json({ alltitlerelease: await listLegacyReleaseTitles(), base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" }, { headers: responseHeaders });
    if (legacyId === undefined && filter === "alltitletrackrelease") return Response.json({ alltitletrackrelease: await listLegacyReleaseTrackTitles(), base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" }, { headers: responseHeaders });
    return Response.json({ error: "Unsupported Release request." }, { status: 400 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid Release request." }, { status: 400 }); }
}
