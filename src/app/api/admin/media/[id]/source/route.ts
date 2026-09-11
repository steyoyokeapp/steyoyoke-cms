import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { readMediaSource } from "@/modules/media/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/admin/media/[id]/source">) {
  try {
    const source = await readMediaSource(await actorFromHeaders(request.headers), (await context.params).id);
    return new Response(new Uint8Array(source.bytes), { headers: { "Content-Type": source.mimeType, "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
