import { actorFromHeaders } from "@/lib/session";
import { requireTrustedMutation } from "@/lib/request-security";
import { errorResponse } from "@/lib/errors";
import { completeTrackAudio, trackAudioStatus } from "@/modules/media/track-audio-upload";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try { requireTrustedMutation(request); return Response.json(await completeTrackAudio(await actorFromHeaders(request.headers), (await context.params).id)); }
  catch (error) { return errorResponse(error); }
}
export async function GET(request: Request, context: Context) {
  try { return Response.json(await trackAudioStatus(await actorFromHeaders(request.headers), (await context.params).id), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error); }
}
