import { handleLegacyArtistRequest } from "@/modules/artists/legacy";
import { handleLegacyTrackRequest } from "@/modules/tracks/legacy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return new URL(request.url).searchParams.get("filter") === "tracks"
    ? handleLegacyTrackRequest(request)
    : handleLegacyArtistRequest(request);
}
