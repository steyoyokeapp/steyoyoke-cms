import { runScheduledArtistPublication } from "@/modules/artists/service";
import { runScheduledTrackPublication } from "@/modules/tracks/service";
import { runScheduledPodcastPublication } from "@/modules/podcasts/service";
import { runScheduledReleasePublication } from "@/modules/releases/service";
import { log } from "@/lib/logger";
import { runMediaProcessingJobs } from "@/modules/media/image-worker";

export async function runScheduledPublication(now = new Date()) {
  const [artists, tracks, podcasts, releases, media] = await Promise.all([
    runScheduledArtistPublication(now),
    runScheduledTrackPublication(now),
    runScheduledPodcastPublication(now),
    runScheduledReleasePublication(now),
    runMediaProcessingJobs({ limit: 5, now }),
  ]);
  log("info", "scheduled_publication_complete", {
    runAt: now.toISOString(),
    artistsExamined: artists.examined, artistsPublished: artists.published,
    tracksExamined: tracks.examined, tracksPublished: tracks.published,
    podcastsExamined: podcasts.examined, podcastsPublished: podcasts.published,
    releasesExamined: releases.examined, releasesPublished: releases.published,
    mediaJobsExamined: media.examined, mediaJobsCompleted: media.completed, mediaJobsRetryPending: media.retryPending, mediaJobsFailed: media.failed,
  });
  return { artists, tracks, podcasts, releases, media };
}
