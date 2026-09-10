import { handleLegacyArtistRequest } from "@/modules/artists/legacy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleLegacyArtistRequest(request);
}
