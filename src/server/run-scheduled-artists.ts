import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { runScheduledArtistPublication } from "@/modules/artists/service";
import { runScheduledTrackPublication } from "@/modules/tracks/service";
import { runScheduledPodcastPublication } from "@/modules/podcasts/service";
import { runScheduledReleasePublication } from "@/modules/releases/service";

try {
  const now = new Date();
  const [artists, tracks, podcasts, releases] = await Promise.all([runScheduledArtistPublication(now), runScheduledTrackPublication(now), runScheduledPodcastPublication(now), runScheduledReleasePublication(now)]);
  console.log(`Scheduled publication complete: Artists ${artists.published}/${artists.examined}; Tracks ${tracks.published}/${tracks.examined}; Podcasts ${podcasts.published}/${podcasts.examined}; Releases ${releases.published}/${releases.examined}.`);
} finally {
  await prisma.$disconnect();
}
