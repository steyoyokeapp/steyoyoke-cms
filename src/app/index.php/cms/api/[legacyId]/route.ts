import { handleLegacyArtistRequest } from "@/modules/artists/legacy";
import { handleLegacyTrackRequest } from "@/modules/tracks/legacy";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ legacyId: string }> };

export async function GET(request: Request, context: Context) {
  const { legacyId } = await context.params;
  const numericId = Number(legacyId);
  if (!/^\d+$/.test(legacyId) || !Number.isSafeInteger(numericId)) {
    return Response.json({ error: "Invalid legacy id." }, { status: 400 });
  }
  return new URL(request.url).searchParams.get("filter") === "tracks"
    ? handleLegacyTrackRequest(request, numericId)
    : handleLegacyArtistRequest(request, numericId);
}
