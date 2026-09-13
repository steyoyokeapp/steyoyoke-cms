import { actorFromHeaders } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { searchChoices } from "@/modules/catalogue/pickers";
export async function GET(request: Request) {
  try {
    const actor = await actorFromHeaders(request.headers);
    return Response.json(
      await searchChoices(
        actor,
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
