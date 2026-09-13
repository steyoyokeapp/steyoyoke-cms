import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { secondaryData } from "@/modules/catalogue/secondary";
export async function GET(request: Request) {
  try {
    return Response.json(
      await secondaryData(
        await actorFromHeaders(request.headers),
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
