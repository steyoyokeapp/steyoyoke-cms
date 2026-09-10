import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { getTrack, updateTrackDraft } from "@/modules/tracks/service";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { return Response.json(await getTrack(await actorFromHeaders(request.headers), (await context.params).id)); }
  catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    requireTrustedMutation(request);
    return Response.json(await updateTrackDraft(await actorFromHeaders(request.headers), (await context.params).id, await request.json()));
  } catch (error) { return errorResponse(error); }
}
