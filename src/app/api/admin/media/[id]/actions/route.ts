import { z } from "zod";
import { after } from "next/server";
import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { permanentlyDeleteMedia, purgeEligibleMedia, retireMedia, retryImageProcessing } from "@/modules/media/service";
import { runMediaProcessingJobs } from "@/modules/media/image-worker";
import { logSafeError } from "@/lib/logger";

const schema = z.discriminatedUnion("action", [z.object({ action: z.literal("retire") }), z.object({ action: z.literal("purgeEligible") }), z.object({ action: z.literal("retryProcessing") }), z.object({ action: z.literal("deletePermanently") })]);
export async function POST(request: Request, context: RouteContext<"/api/admin/media/[id]/actions">) {
  try {
    requireTrustedMutation(request); const actor = await actorFromHeaders(request.headers); const id = (await context.params).id; const payload = schema.parse(await request.json());
    if (payload.action === "retryProcessing") {
      const asset = await retryImageProcessing(actor, id);
      after(async () => {
        try { await runMediaProcessingJobs({ limit: 1, mediaAssetId: id }); }
        catch (error) { logSafeError("media_image_processing_kick_failed", error, { operation: "image processing retry kick", mediaAssetId: id }); }
      });
      return Response.json(asset);
    }
    if (payload.action === "deletePermanently") return Response.json(await permanentlyDeleteMedia(actor, id));
    return Response.json(payload.action === "retire" ? await retireMedia(actor, id) : await purgeEligibleMedia(actor));
  } catch (error) { return errorResponse(error); }
}
