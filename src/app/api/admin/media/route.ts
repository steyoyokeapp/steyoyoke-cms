import { after } from "next/server";
import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { parseMediaBrowse } from "@/modules/media/browse";
import { createAndProcessAudio, createAndProcessImage, listMediaAssets } from "@/modules/media/service";
import { runMediaProcessingJobs } from "@/modules/media/image-worker";
import { logSafeError } from "@/lib/logger";

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    return Response.json(await listMediaAssets(await actorFromHeaders(request.headers), {
      ...parseMediaBrowse(query), limit: query.has("limit") ? Number(query.get("limit")) : undefined,
    }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const requestStartedAtMs = performance.now();
  try {
    requireTrustedMutation(request); const actor = await actorFromHeaders(request.headers); const parseStartedAtMs = performance.now(); const data = await request.formData(); const file = data.get("file");
    if (!(file instanceof File)) return Response.json({ error: { code: "FILE_REQUIRED", message: "Choose a media file." } }, { status: 422 });
    const input = { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
    const parseMs = performance.now() - parseStartedAtMs;
    const requestId = [request.headers.get("x-vercel-id"), request.headers.get("x-request-id")].find((value) => value && /^[a-zA-Z0-9._:/-]{1,200}$/.test(value)) ?? undefined;
    if (data.get("kind") === "AUDIO") return Response.json(await createAndProcessAudio(actor, input), { status: 201 });
    const asset = await createAndProcessImage(actor, input, undefined, { requestId, requestStartedAtMs, parseMs });
    after(async () => {
      try { await runMediaProcessingJobs({ limit: 1, mediaAssetId: asset.id }); }
      catch (error) { logSafeError("media_image_processing_kick_failed", error, { requestId, operation: "image processing kick", mediaAssetId: asset.id }); }
    });
    return Response.json(asset, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
