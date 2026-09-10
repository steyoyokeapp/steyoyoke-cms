import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { getMediaAsset } from "@/modules/media/service";

export async function GET(request: Request, context: RouteContext<"/api/admin/media/[id]">) {
  try { return Response.json(await getMediaAsset(await actorFromHeaders(request.headers), (await context.params).id)); } catch (error) { return errorResponse(error); }
}
