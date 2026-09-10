import { z } from "zod";
import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { reorderReleaseTracks, replaceReleaseTracks } from "@/modules/releases/service";

type Context = { params: Promise<{ id: string }> };
const payloadSchema = z.object({ expectedWorkingVersion: z.number().int().positive(), trackIds: z.array(z.uuid()), mode: z.enum(["replace", "reorder"]).default("replace") });
export async function PUT(request: Request, context: Context) {
  try {
    requireTrustedMutation(request); const actor = await actorFromHeaders(request.headers); const id = (await context.params).id; const payload = payloadSchema.parse(await request.json());
    return Response.json(payload.mode === "reorder" ? await reorderReleaseTracks(actor, id, payload) : await replaceReleaseTracks(actor, id, payload));
  } catch (error) { return errorResponse(error); }
}
