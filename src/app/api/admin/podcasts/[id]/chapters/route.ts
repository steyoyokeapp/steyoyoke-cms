import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { replacePodcastChapters } from "@/modules/podcasts/service";

type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  try { requireTrustedMutation(request); return Response.json(await replacePodcastChapters(await actorFromHeaders(request.headers), (await context.params).id, await request.json())); } catch (error) { return errorResponse(error); }
}
