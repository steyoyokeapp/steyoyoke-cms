import { timingSafeEqual } from "node:crypto";
import { errorResponse } from "@/lib/errors";
import { AppError } from "@/lib/errors";
import { runScheduledPublication } from "@/server/scheduled-publication";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const configured = process.env.SCHEDULED_PUBLISHER_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!configured || configured.length < 32 || !supplied) return false;
  const expected = Buffer.from(configured); const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function POST(request: Request) {
  try {
    if (process.env.SCHEDULED_PUBLISHER_ENABLED !== "true") throw new AppError("Scheduled publisher is disabled.", 503, "SCHEDULER_DISABLED");
    if (!authorized(request)) throw new AppError("Unauthorized.", 401, "UNAUTHORIZED");
    return Response.json(await runScheduledPublication());
  } catch (error) {
    return errorResponse(error);
  }
}
