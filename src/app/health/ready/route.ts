import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ready", database: "reachable" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    log("error", "readiness_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ status: "not_ready", database: "unreachable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
