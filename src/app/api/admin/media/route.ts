import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { MediaKind } from "@/generated/prisma/client";
import { createAndProcessAudio, createAndProcessImage, listMediaAssets } from "@/modules/media/service";

export async function GET(request: Request) {
  try { const raw = new URL(request.url).searchParams.get("kind"); const kind = raw && Object.values(MediaKind).includes(raw as MediaKind) ? raw as MediaKind : undefined; return Response.json(await listMediaAssets(await actorFromHeaders(request.headers), kind)); } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request); const actor = await actorFromHeaders(request.headers); const data = await request.formData(); const file = data.get("file");
    if (!(file instanceof File)) return Response.json({ error: { code: "FILE_REQUIRED", message: "Choose a media file." } }, { status: 422 });
    const input = { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
    return Response.json(data.get("kind") === "AUDIO" ? await createAndProcessAudio(actor, input) : await createAndProcessImage(actor, input), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
