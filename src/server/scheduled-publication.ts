import { runScheduledArtistPublication } from "@/modules/artists/service";
import { runScheduledTrackPublication } from "@/modules/tracks/service";
import { runScheduledPodcastPublication } from "@/modules/podcasts/service";
import { runScheduledReleasePublication } from "@/modules/releases/service";
import { log } from "@/lib/logger";

export async function runScheduledPublication(now = new Date()) {
  const [artists, tracks, podcasts, releases] = await Promise.all([
    runScheduledArtistPublication(now),
    runScheduledTrackPublication(now),
    runScheduledPodcastPublication(now),
    runScheduledReleasePublication(now),
  ]);
  log("info", "scheduled_publication_complete", {
    runAt: now.toISOString(),
    artistsExamined: artists.examined, artistsPublished: artists.published,
    tracksExamined: tracks.examined, tracksPublished: tracks.published,
    podcastsExamined: podcasts.examined, podcastsPublished: podcasts.published,
    releasesExamined: releases.examined, releasesPublished: releases.published,
  });
  return { artists, tracks, podcasts, releases };
}
