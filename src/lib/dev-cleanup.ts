import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

const suffix = "[0-9]{13}";
const artistPattern = new RegExp(`^(?:E2E (?:Artist|Draft)|Track E2E Artist|Podcast E2E Artist|Release E2E Artist|Media E2E Artist|Audio E2E Artist) ${suffix}$`);
const trackPatterns = [
  new RegExp(`^Track E2E(?: Draft)? ${suffix}$`),
  new RegExp(`^Release Track [AB] ${suffix}(?: r2)?$`),
  new RegExp(`^Audio Track ${suffix}$`),
];
const podcastPattern = new RegExp(`^(?:Steyoyoke Podcast E2E|Podcast E2E Updated|Audio Podcast) ${suffix}$`);
const releasePattern = new RegExp(`^(?:Steyoyoke Release E2E|Release E2E Updated) ${suffix}$`);
const mediaPattern = new RegExp(`^(?:media-[ab]-${suffix}\.png|audio-[ab]-${suffix}\.mp3|audio-podcast-${suffix}\.png|podcast-${suffix}\.(?:png|mp3)|release-${suffix}\.png)$`);

export const localE2EMarkers = {
  artist: (value: string) => artistPattern.test(value),
  track: (value: string) => trackPatterns.some((pattern) => pattern.test(value)),
  podcast: (value: string) => podcastPattern.test(value),
  release: (value: string) => releasePattern.test(value),
  media: (value: string | null) => Boolean(value && mediaPattern.test(value)),
};

type Targets = { artistIds: string[]; trackIds: string[]; podcastIds: string[]; releaseIds: string[]; mediaAssetIds: string[]; sessionIds: string[] };

export type LocalE2ECleanupCounts = {
  artists: number; artistRevisions: number; artistAuditLogs: number;
  tracks: number; trackRevisions: number; trackAuditLogs: number;
  podcasts: number; podcastChapters: number; podcastRevisions: number; podcastChapterRevisions: number; podcastAuditLogs: number;
  releases: number; releaseTracks: number; releaseRevisions: number; releaseRevisionTracks: number; releaseAuditLogs: number;
  mediaAssets: number; mediaVariants: number; mediaAuditLogs: number; protectedMediaAssets: number;
  automatedNonAdminSessions: number; protectedCatalogueRecords: number;
};

function add(values: Set<string>, ...candidates: Array<string | null>) { for (const value of candidates) if (value) values.add(value); }

async function collectTargets(db: Db) {
  const [artists, tracks, podcasts, releases, media, sessions] = await Promise.all([
    db.artist.findMany({ select: { id: true, name: true } }),
    db.track.findMany({ select: { id: true, title: true } }),
    db.podcastEpisode.findMany({ select: { id: true, title: true } }),
    db.release.findMany({ select: { id: true, title: true } }),
    db.mediaAsset.findMany({ select: { id: true, originalFilename: true } }),
    db.session.findMany({ where: { user: { role: { not: "ADMIN" } }, OR: [{ userAgent: { contains: "HeadlessChrome", mode: "insensitive" } }, { userAgent: { contains: "Playwright", mode: "insensitive" } }] }, select: { id: true } }),
  ]);
  const roots = {
    artistIds: artists.filter(({ name }) => localE2EMarkers.artist(name)).map(({ id }) => id),
    trackIds: tracks.filter(({ title }) => localE2EMarkers.track(title)).map(({ id }) => id),
    podcastIds: podcasts.filter(({ title }) => localE2EMarkers.podcast(title)).map(({ id }) => id),
    releaseIds: releases.filter(({ title }) => localE2EMarkers.release(title)).map(({ id }) => id),
    markedMediaIds: media.filter(({ originalFilename }) => localE2EMarkers.media(originalFilename)).map(({ id }) => id),
    sessionIds: sessions.map(({ id }) => id),
  };

  const protectedTracks = new Set<string>();
  if (roots.trackIds.length) {
    const [releaseTracks, releaseRevisionTracks] = await Promise.all([
      db.releaseTrack.findMany({ where: { trackId: { in: roots.trackIds }, releaseId: { notIn: roots.releaseIds } }, select: { trackId: true } }),
      db.releaseRevisionTrack.findMany({
        where: { trackRevision: { trackId: { in: roots.trackIds } }, releaseRevision: { releaseId: { notIn: roots.releaseIds } } },
        select: { trackRevision: { select: { trackId: true } } },
      }),
    ]);
    for (const row of releaseTracks) protectedTracks.add(row.trackId);
    for (const row of releaseRevisionTracks) protectedTracks.add(row.trackRevision.trackId);
  }
  const trackIds = roots.trackIds.filter((id) => !protectedTracks.has(id));

  const protectedArtists = new Set<string>();
  if (roots.artistIds.length) {
    const references = await Promise.all([
      db.track.findMany({ where: { id: { notIn: trackIds }, OR: [{ primaryArtistId: { in: roots.artistIds } }, { secondaryArtistId: { in: roots.artistIds } }] }, select: { primaryArtistId: true, secondaryArtistId: true } }),
      db.trackRevision.findMany({ where: { trackId: { notIn: trackIds }, OR: [{ primaryArtistId: { in: roots.artistIds } }, { secondaryArtistId: { in: roots.artistIds } }] }, select: { primaryArtistId: true, secondaryArtistId: true } }),
      db.podcastEpisode.findMany({ where: { id: { notIn: roots.podcastIds }, OR: [{ primaryArtistId: { in: roots.artistIds } }, { secondaryArtistId: { in: roots.artistIds } }] }, select: { primaryArtistId: true, secondaryArtistId: true } }),
      db.podcastEpisodeRevision.findMany({ where: { episodeId: { notIn: roots.podcastIds }, OR: [{ primaryArtistId: { in: roots.artistIds } }, { secondaryArtistId: { in: roots.artistIds } }] }, select: { primaryArtistId: true, secondaryArtistId: true } }),
      db.release.findMany({ where: { id: { notIn: roots.releaseIds }, OR: [{ primaryArtistId: { in: roots.artistIds } }, { secondaryArtistId: { in: roots.artistIds } }] }, select: { primaryArtistId: true, secondaryArtistId: true } }),
      db.releaseRevision.findMany({ where: { releaseId: { notIn: roots.releaseIds }, OR: [{ primaryArtistId: { in: roots.artistIds } }, { secondaryArtistId: { in: roots.artistIds } }] }, select: { primaryArtistId: true, secondaryArtistId: true } }),
    ]);
    for (const row of references.flat()) add(protectedArtists, row.primaryArtistId, row.secondaryArtistId);
  }
  const artistIds = roots.artistIds.filter((id) => !protectedArtists.has(id));

  const protectedMedia = new Set<string>();
  if (roots.markedMediaIds.length) {
    const references = await Promise.all([
      db.artist.findMany({ where: { imageAssetId: { in: roots.markedMediaIds }, id: { notIn: artistIds } }, select: { imageAssetId: true } }),
      db.artistRevision.findMany({ where: { imageAssetId: { in: roots.markedMediaIds }, artistId: { notIn: artistIds } }, select: { imageAssetId: true } }),
      db.track.findMany({ where: { id: { notIn: trackIds }, OR: [{ artworkAssetId: { in: roots.markedMediaIds } }, { audioAssetId: { in: roots.markedMediaIds } }] }, select: { artworkAssetId: true, audioAssetId: true } }),
      db.trackRevision.findMany({ where: { trackId: { notIn: trackIds }, OR: [{ artworkAssetId: { in: roots.markedMediaIds } }, { audioAssetId: { in: roots.markedMediaIds } }] }, select: { artworkAssetId: true, audioAssetId: true } }),
      db.podcastEpisode.findMany({ where: { id: { notIn: roots.podcastIds }, OR: [{ artworkAssetId: { in: roots.markedMediaIds } }, { audioAssetId: { in: roots.markedMediaIds } }] }, select: { artworkAssetId: true, audioAssetId: true } }),
      db.podcastEpisodeRevision.findMany({ where: { episodeId: { notIn: roots.podcastIds }, OR: [{ artworkAssetId: { in: roots.markedMediaIds } }, { audioAssetId: { in: roots.markedMediaIds } }] }, select: { artworkAssetId: true, audioAssetId: true } }),
      db.release.findMany({ where: { artworkAssetId: { in: roots.markedMediaIds }, id: { notIn: roots.releaseIds } }, select: { artworkAssetId: true } }),
      db.releaseRevision.findMany({ where: { artworkAssetId: { in: roots.markedMediaIds }, releaseId: { notIn: roots.releaseIds } }, select: { artworkAssetId: true } }),
    ]);
    for (const row of references.flat()) {
      if ("imageAssetId" in row) add(protectedMedia, row.imageAssetId);
      if ("artworkAssetId" in row) add(protectedMedia, row.artworkAssetId, "audioAssetId" in row ? row.audioAssetId : null);
    }
  }

  const targets: Targets = { artistIds, trackIds, podcastIds: roots.podcastIds, releaseIds: roots.releaseIds, mediaAssetIds: roots.markedMediaIds.filter((id) => !protectedMedia.has(id)), sessionIds: roots.sessionIds };
  return { targets, protectedMediaAssets: protectedMedia.size, protectedCatalogueRecords: protectedArtists.size + protectedTracks.size };
}

async function plan(db: Db) {
  const { targets, protectedMediaAssets, protectedCatalogueRecords } = await collectTargets(db);
  const { artistIds, trackIds, podcastIds, releaseIds, mediaAssetIds, sessionIds } = targets;
  const [artistRevisions, artistAuditLogs, trackRevisions, trackAuditLogs, podcastChapters, podcastRevisions, podcastChapterRevisions, podcastAuditLogs, releaseTracks, releaseRevisions, releaseRevisionTracks, releaseAuditLogs, mediaVariants, mediaAuditLogs] = await Promise.all([
    db.artistRevision.count({ where: { artistId: { in: artistIds } } }), db.auditLog.count({ where: { artistId: { in: artistIds } } }),
    db.trackRevision.count({ where: { trackId: { in: trackIds } } }), db.trackAuditLog.count({ where: { trackId: { in: trackIds } } }),
    db.podcastChapter.count({ where: { episodeId: { in: podcastIds } } }), db.podcastEpisodeRevision.count({ where: { episodeId: { in: podcastIds } } }),
    db.podcastChapterRevision.count({ where: { episodeRevision: { episodeId: { in: podcastIds } } } }), db.podcastAuditLog.count({ where: { episodeId: { in: podcastIds } } }),
    db.releaseTrack.count({ where: { releaseId: { in: releaseIds } } }), db.releaseRevision.count({ where: { releaseId: { in: releaseIds } } }),
    db.releaseRevisionTrack.count({ where: { releaseRevision: { releaseId: { in: releaseIds } } } }), db.releaseAuditLog.count({ where: { releaseId: { in: releaseIds } } }),
    db.mediaVariant.count({ where: { mediaAssetId: { in: mediaAssetIds } } }), db.mediaAuditLog.count({ where: { mediaAssetId: { in: mediaAssetIds } } }),
  ]);
  const counts: LocalE2ECleanupCounts = {
    artists: artistIds.length, artistRevisions, artistAuditLogs, tracks: trackIds.length, trackRevisions, trackAuditLogs,
    podcasts: podcastIds.length, podcastChapters, podcastRevisions, podcastChapterRevisions, podcastAuditLogs,
    releases: releaseIds.length, releaseTracks, releaseRevisions, releaseRevisionTracks, releaseAuditLogs,
    mediaAssets: mediaAssetIds.length, mediaVariants, mediaAuditLogs, protectedMediaAssets,
    automatedNonAdminSessions: sessionIds.length, protectedCatalogueRecords,
  };
  return { targets, counts };
}

export async function previewLocalE2ECleanup(db: Db = prisma) { return (await plan(db)).counts; }

async function setRevisionDeletionTriggers(transaction: Prisma.TransactionClient, enabled: boolean) {
  const action = enabled ? "ENABLE" : "DISABLE";
  const triggers = [
    ['"artist_revisions"', '"artist_revisions_immutable"'],
    ['"track_revisions"', '"track_revisions_immutable"'],
    ['"podcast_episode_revisions"', '"podcast_episode_revisions_immutable"'],
    ['"podcast_chapter_revisions"', '"podcast_chapter_revisions_immutable"'],
    ['"release_revisions"', '"release_revisions_immutable"'],
    ['"release_revision_tracks"', '"release_revision_tracks_immutable"'],
  ] as const;
  for (const [table, trigger] of triggers) await transaction.$executeRawUnsafe(`ALTER TABLE ${table} ${action} TRIGGER ${trigger}`);
}

export async function applyLocalE2ECleanup() {
  return prisma.$transaction(async (transaction) => {
    const { targets, counts } = await plan(transaction);
    const { artistIds, trackIds, podcastIds, releaseIds, mediaAssetIds, sessionIds } = targets;
    await setRevisionDeletionTriggers(transaction, false);

    await transaction.release.updateMany({ where: { id: { in: releaseIds } }, data: { status: "DRAFT", publishedRevisionId: null, scheduledRevisionId: null, scheduledFor: null, archivedAt: null } });
    await transaction.releaseAuditLog.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await transaction.releaseRevisionTrack.deleteMany({ where: { releaseRevision: { releaseId: { in: releaseIds } } } });
    await transaction.releaseTrack.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await transaction.releaseRevision.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await transaction.release.deleteMany({ where: { id: { in: releaseIds } } });

    await transaction.podcastEpisode.updateMany({ where: { id: { in: podcastIds } }, data: { status: "DRAFT", publishedRevisionId: null, scheduledRevisionId: null, scheduledFor: null, archivedAt: null } });
    await transaction.podcastAuditLog.deleteMany({ where: { episodeId: { in: podcastIds } } });
    await transaction.podcastChapterRevision.deleteMany({ where: { episodeRevision: { episodeId: { in: podcastIds } } } });
    await transaction.podcastChapter.deleteMany({ where: { episodeId: { in: podcastIds } } });
    await transaction.podcastEpisodeRevision.deleteMany({ where: { episodeId: { in: podcastIds } } });
    await transaction.podcastEpisode.deleteMany({ where: { id: { in: podcastIds } } });

    await transaction.track.updateMany({ where: { id: { in: trackIds } }, data: { status: "DRAFT", publishedRevisionId: null, scheduledRevisionId: null, scheduledFor: null, archivedAt: null } });
    await transaction.trackAuditLog.deleteMany({ where: { trackId: { in: trackIds } } });
    await transaction.trackRevision.deleteMany({ where: { trackId: { in: trackIds } } });
    await transaction.track.deleteMany({ where: { id: { in: trackIds } } });

    await transaction.artist.updateMany({ where: { id: { in: artistIds } }, data: { status: "DRAFT", publishedRevisionId: null, scheduledRevisionId: null, scheduledFor: null, archivedAt: null } });
    await transaction.auditLog.deleteMany({ where: { artistId: { in: artistIds } } });
    await transaction.artistRevision.deleteMany({ where: { artistId: { in: artistIds } } });
    await transaction.artist.deleteMany({ where: { id: { in: artistIds } } });

    await transaction.mediaAsset.updateMany({ where: { id: { in: mediaAssetIds } }, data: { status: "RETIRED", retiredAt: new Date() } });
    await transaction.mediaVariant.deleteMany({ where: { mediaAssetId: { in: mediaAssetIds } } });
    await transaction.mediaAuditLog.deleteMany({ where: { mediaAssetId: { in: mediaAssetIds } } });
    await transaction.mediaAsset.deleteMany({ where: { id: { in: mediaAssetIds } } });
    await transaction.session.deleteMany({ where: { id: { in: sessionIds }, user: { role: { not: "ADMIN" } } } });
    await setRevisionDeletionTriggers(transaction, true);
    return counts;
  });
}
