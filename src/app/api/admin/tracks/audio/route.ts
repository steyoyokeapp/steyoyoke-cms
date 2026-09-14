import { actorFromHeaders } from "@/lib/session";
import { requireTrustedMutation } from "@/lib/request-security";
import { errorResponse } from "@/lib/errors";
import { reserveTrackAudio } from "@/modules/media/track-audio-upload";
export async function POST(request: Request) {
  try { requireTrustedMutation(request); return Response.json(await reserveTrackAudio(await actorFromHeaders(request.headers), await request.json()), { status: 201 }); }
  catch (error) { return errorResponse(error); }
}
