import { handleLegacyArtistRequest } from "@/modules/artists/legacy";
import { handleLegacyTrackRequest } from "@/modules/tracks/legacy";
import { handleLegacyPodcastRequest } from "@/modules/podcasts/legacy";
import { handleLegacyReleaseRequest } from "@/modules/releases/legacy";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ legacyId: string }> };

export async function GET(request: Request, context: Context) {
  const { legacyId } = await context.params;
  const numericId = Number(legacyId);
  if (!/^\d+$/.test(legacyId) || !Number.isSafeInteger(numericId)) {
    return Response.json({ error: "Invalid legacy id." }, { status: 400 });
  }
  const params = new URL(request.url).searchParams;
  if (["releases", "releasecomplete"].includes(params.get("filter") ?? "")) return handleLegacyReleaseRequest(request, numericId);
  if (params.get("filter") === "tracks" && params.get("type") === "podcast") return handleLegacyPodcastRequest(request, numericId);
  return params.get("filter") === "tracks" ? handleLegacyTrackRequest(request, numericId) : handleLegacyArtistRequest(request, numericId);
}
