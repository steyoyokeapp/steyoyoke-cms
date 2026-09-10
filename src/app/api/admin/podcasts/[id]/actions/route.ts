import { z } from "zod";
import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { archivePodcast, cancelPodcastSchedule, publishPodcast, restorePodcast, schedulePodcast, unpublishPodcast } from "@/modules/podcasts/service";

type Context = { params: Promise<{ id: string }> };
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), expectedWorkingVersion: z.number().int().positive() }),
  z.object({ action: z.literal("schedule"), expectedWorkingVersion: z.number().int().positive(), scheduledFor: z.string() }),
  z.object({ action: z.literal("cancelSchedule") }), z.object({ action: z.literal("unpublish") }), z.object({ action: z.literal("archive") }), z.object({ action: z.literal("restore") }),
]);
export async function POST(request: Request, context: Context) {
  try {
    requireTrustedMutation(request); const actor = await actorFromHeaders(request.headers); const id = (await context.params).id; const payload = actionSchema.parse(await request.json());
    switch (payload.action) {
      case "publish": return Response.json(await publishPodcast(actor, id, payload)); case "schedule": return Response.json(await schedulePodcast(actor, id, payload));
      case "cancelSchedule": return Response.json(await cancelPodcastSchedule(actor, id)); case "unpublish": return Response.json(await unpublishPodcast(actor, id));
      case "archive": return Response.json(await archivePodcast(actor, id)); case "restore": return Response.json(await restorePodcast(actor, id));
    }
  } catch (error) { return errorResponse(error); }
}
