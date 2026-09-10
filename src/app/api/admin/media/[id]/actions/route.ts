import { z } from "zod";
import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { purgeEligibleMedia, retireMedia } from "@/modules/media/service";

const schema = z.discriminatedUnion("action", [z.object({ action: z.literal("retire") }), z.object({ action: z.literal("purgeEligible") })]);
export async function POST(request: Request, context: RouteContext<"/api/admin/media/[id]/actions">) {
  try {
    requireTrustedMutation(request); const actor = await actorFromHeaders(request.headers); const id = (await context.params).id; const payload = schema.parse(await request.json());
    return Response.json(payload.action === "retire" ? await retireMedia(actor, id) : await purgeEligibleMedia(actor));
  } catch (error) { return errorResponse(error); }
}
