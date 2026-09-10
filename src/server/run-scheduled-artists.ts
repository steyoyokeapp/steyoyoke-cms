import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runScheduledPublication } from "@/server/scheduled-publication";

try {
  if (process.env.SCHEDULED_PUBLISHER_ENABLED !== "true") throw new Error("Scheduled publisher is disabled. Set SCHEDULED_PUBLISHER_ENABLED=true for the dedicated worker.");
  await runScheduledPublication();
} finally {
  await prisma.$disconnect();
}
