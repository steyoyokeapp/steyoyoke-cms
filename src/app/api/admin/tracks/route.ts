import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { createTrack, listTracks } from "@/modules/tracks/service";

export async function GET(request: Request) {
  try {
    const actor = await actorFromHeaders(request.headers);
    const params = new URL(request.url).searchParams;
    return Response.json(await listTracks(actor, { q: params.get("q") || undefined, artistId: params.get("artistId") || undefined, labelId: params.get("labelId") || undefined, status: params.get("status") || undefined }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const actor = await actorFromHeaders(request.headers);
    return Response.json(await createTrack(actor, await request.json()), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
