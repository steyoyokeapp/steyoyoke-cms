import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { requireTrustedMutation } from "@/lib/request-security";
import { createAndProcessImage, listMediaAssets } from "@/modules/media/service";

export async function GET(request: Request) {
  try { return Response.json(await listMediaAssets(await actorFromHeaders(request.headers))); } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request); const actor = await actorFromHeaders(request.headers); const data = await request.formData(); const file = data.get("file");
    if (!(file instanceof File)) return Response.json({ error: { code: "FILE_REQUIRED", message: "Choose an image file." } }, { status: 422 });
    return Response.json(await createAndProcessImage(actor, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
