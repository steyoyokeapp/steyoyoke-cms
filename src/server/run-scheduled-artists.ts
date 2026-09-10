import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runScheduledArtistPublication } from "@/modules/artists/service";
import { runScheduledTrackPublication } from "@/modules/tracks/service";

try {
  const now = new Date();
  const [artists, tracks] = await Promise.all([runScheduledArtistPublication(now), runScheduledTrackPublication(now)]);
  console.log(`Scheduled publication complete: Artists ${artists.published}/${artists.examined}; Tracks ${tracks.published}/${tracks.examined}.`);
} finally {
  await prisma.$disconnect();
}
