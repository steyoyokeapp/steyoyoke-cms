import { z } from "zod";
import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import {
  archiveArtist,
  cancelArtistSchedule,
  hardDeleteArtist,
  publishArtist,
  restoreArtist,
  scheduleArtist,
  unpublishArtist,
} from "@/modules/artists/service";
import { requireTrustedMutation } from "@/lib/request-security";

type Context = { params: Promise<{ id: string }> };
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), expectedWorkingVersion: z.number().int().positive() }),
  z.object({ action: z.literal("schedule"), expectedWorkingVersion: z.number().int().positive(), scheduledFor: z.string() }),
  z.object({ action: z.literal("cancelSchedule") }),
  z.object({ action: z.literal("unpublish") }),
  z.object({ action: z.literal("archive") }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("hardDelete") }),
]);

export async function POST(request: Request, context: Context) {
  try {
    requireTrustedMutation(request);
    const actor = await actorFromHeaders(request.headers);
    const { id } = await context.params;
    const payload = actionSchema.parse(await request.json());
    switch (payload.action) {
      case "publish":
        return Response.json(await publishArtist(actor, id, payload));
      case "schedule":
        return Response.json(await scheduleArtist(actor, id, payload));
      case "cancelSchedule":
        return Response.json(await cancelArtistSchedule(actor, id));
      case "unpublish":
        return Response.json(await unpublishArtist(actor, id));
      case "archive":
        return Response.json(await archiveArtist(actor, id));
      case "restore":
        return Response.json(await restoreArtist(actor, id));
      case "hardDelete":
        return Response.json(await hardDeleteArtist(actor, id));
    }
  } catch (error) {
    return errorResponse(error);
  }
}
