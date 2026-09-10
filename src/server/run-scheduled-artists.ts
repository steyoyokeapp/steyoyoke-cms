import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runScheduledArtistPublication } from "@/modules/artists/service";
import { runScheduledTrackPublication } from "@/modules/tracks/service";
import { runScheduledPodcastPublication } from "@/modules/podcasts/service";

try {
  const now = new Date();
  const [artists, tracks, podcasts] = await Promise.all([runScheduledArtistPublication(now), runScheduledTrackPublication(now), runScheduledPodcastPublication(now)]);
  console.log(`Scheduled publication complete: Artists ${artists.published}/${artists.examined}; Tracks ${tracks.published}/${tracks.examined}; Podcasts ${podcasts.published}/${podcasts.examined}.`);
} finally {
  await prisma.$disconnect();
}
