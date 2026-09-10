import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { getArtist, updateArtistDraft } from "@/modules/artists/service";
import { requireTrustedMutation } from "@/lib/request-security";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const actor = await actorFromHeaders(request.headers);
    const { id } = await context.params;
    return Response.json(await getArtist(actor, id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    requireTrustedMutation(request);
    const actor = await actorFromHeaders(request.headers);
    const { id } = await context.params;
    return Response.json(await updateArtistDraft(actor, id, await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}
