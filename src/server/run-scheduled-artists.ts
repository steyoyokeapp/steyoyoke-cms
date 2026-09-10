import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runScheduledArtistPublication } from "@/modules/artists/service";

try {
  const result = await runScheduledArtistPublication(new Date());
  console.log(`Scheduled artist publication complete: ${result.published}/${result.examined} published.`);
} finally {
  await prisma.$disconnect();
}
