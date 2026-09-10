import { actorFromHeaders } from "@/lib/session";
import { createArtist, listArtists } from "@/modules/artists/service";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";

export async function GET(request: Request) {
  try {
    const actor = await actorFromHeaders(request.headers);
    const url = new URL(request.url);
    return Response.json(await listArtists(actor, {
      q: url.searchParams.get("q") || undefined,
      status: url.searchParams.get("status") || undefined,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const actor = await actorFromHeaders(request.headers);
    const artist = await createArtist(actor, await request.json());
    return Response.json(artist, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
