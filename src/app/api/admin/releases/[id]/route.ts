import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { getRelease, updateReleaseDraft } from "@/modules/releases/service";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { return Response.json(await getRelease(await actorFromHeaders(request.headers), (await context.params).id)); } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try { requireTrustedMutation(request); return Response.json(await updateReleaseDraft(await actorFromHeaders(request.headers), (await context.params).id, await request.json())); } catch (error) { return errorResponse(error); }
}
