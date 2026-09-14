import { handleLegacyArtistRequest } from "@/modules/artists/legacy";
import { handleLegacyTrackRequest } from "@/modules/tracks/legacy";
import { handleLegacyPodcastArtistsRequest, handleLegacyPodcastRequest } from "@/modules/podcasts/legacy";
import { handleLegacyReleaseRequest } from "@/modules/releases/legacy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("filter") === "allpodcastartist") return handleLegacyPodcastArtistsRequest(request);
  if (["releases", "releasefilter", "allreleaseartist", "alltitlerelease", "alltitletrackrelease"].includes(params.get("filter") ?? "")) return handleLegacyReleaseRequest(request);
  if (params.get("filter") === "tracks" && params.get("type") === "podcast") return handleLegacyPodcastRequest(request);
  return params.get("filter") === "tracks" ? handleLegacyTrackRequest(request) : handleLegacyArtistRequest(request);
}
