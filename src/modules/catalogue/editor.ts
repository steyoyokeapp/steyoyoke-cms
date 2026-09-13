import { revealTiming } from "@/lib/reveal-timing";
import { prisma } from "@/lib/prisma";
import { requirePermission, type Actor } from "@/lib/authorization";
import { AppError } from "@/lib/errors";
import { mediaChoiceSelect, trackChoiceSelect, trackChoice } from "./pickers";
import { filterOptions } from "./reads";
import { measureRead } from "@/lib/read-performance";
const artistChoice = { id: true, name: true, legacyId: true } as const;
const revision = {
  id: true,
  revisionNumber: true,
  sourceWorkingVersion: true,
} as const;
const state = {
  id: true,
  legacyId: true,
  status: true,
  workingVersion: true,
  scheduledFor: true,
  publishedRevision: { select: revision },
  scheduledRevision: { select: revision },
} as const;
const links = {
  spotifyUrl: true,
  beatportUrl: true,
  traxsourceUrl: true,
  bandcampUrl: true,
  appleMusicUrl: true,
  soundcloudUrl: true,
} as const;
const relations = {
  primaryArtistId: true,
  secondaryArtistId: true,
  labelId: true,
  primaryArtist: { select: artistChoice },
  secondaryArtist: { select: artistChoice },
} as const;
const artwork = {
  artworkAssetId: true,
  artworkAsset: { select: mediaChoiceSelect },
} as const;
const audio = {
  audioAssetId: true,
  audioAsset: { select: mediaChoiceSelect },
} as const;
export const editorSelect = {
  artists: {
    id: true,
    name: true,
    status: true,
    workingVersion: true,
  },
  tracks: {
    ...state,
    ...links,
    ...relations,
    ...artwork,
    ...audio,
    title: true,
    durationMs: true,
  },
  podcasts: {
    ...state,
    ...relations,
    ...artwork,
    ...audio,
    title: true,
    episodeDate: true,
    durationMs: true,
    chapters: {
      select: {
        id: true,
        artist: true,
        title: true,
        legacyReference: true,
        durationMs: true,
      },
      orderBy: { position: "asc" },
    },
  },
  releases: {
    ...state,
    ...links,
    ...relations,
    ...artwork,
    title: true,
    releaseDate: true,
    tracks: {
      select: { trackId: true, track: { select: trackChoiceSelect } },
      orderBy: { position: "asc" },
    },
    publishedRevision: {
      select: {
        ...revision,
        tracks: {
          select: {
            trackRevision: { select: { trackId: true } },
            trackRevisionId: true,
          },
          orderBy: { position: "asc" },
        },
      },
    },
  },
} as const;
function found<T>(x: T | null): T {
  if (!x) throw new AppError("Record not found.", 404, "NOT_FOUND");
  return x;
}
const date = (x: Date | null) => x?.toISOString() ?? null;
export async function artistEditor(actor: Actor, id: string) {
  requirePermission(actor, "artist:read");
  return measureRead("artists.detail", async () => {
    const artist = found(await prisma.artist.findUnique({
      where: { id },
      select: editorSelect.artists,
    }));
    return { artist };
  });
}
export async function trackEditor(actor: Actor, id: string) {
  requirePermission(actor, "track:read");
  return measureRead("tracks.detail", async () => {
    const { primaryArtist, secondaryArtist, artworkAsset, audioAsset, ...r } =
      found(
        await prisma.track.findUnique({
          where: { id },
          select: editorSelect.tracks,
        }),
      );
    const { labels } = await filterOptions(actor, undefined, r.labelId);
    return {
      track: { ...r, scheduledFor: date(r.scheduledFor) },
      artists: [primaryArtist, ...(secondaryArtist ? [secondaryArtist] : [])],
      labels,
      mediaAssets: artworkAsset ? [artworkAsset] : [],
      audioAssets: audioAsset ? [audioAsset] : [],
    };
  });
}
export async function podcastEditor(actor: Actor, id: string) {
  requirePermission(actor, "podcast:read");
  return measureRead("podcasts.detail", async () => {
    const { primaryArtist, secondaryArtist, artworkAsset, audioAsset, ...r } =
      found(
        await prisma.podcastEpisode.findUnique({
          where: { id },
          select: editorSelect.podcasts,
        }),
      );
    const { labels } = await filterOptions(actor, undefined, r.labelId);
    return {
      podcast: {
        ...r,
        episodeDate: r.episodeDate?.toISOString().slice(0, 10) ?? "",
        scheduledFor: date(r.scheduledFor),
      },
      artists: [primaryArtist, ...(secondaryArtist ? [secondaryArtist] : [])],
      labels,
      mediaAssets: artworkAsset ? [artworkAsset] : [],
      audioAssets: audioAsset ? [audioAsset] : [],
    };
  });
}
export async function releaseEditor(actor: Actor, id: string) {
  requirePermission(actor, "release:read");
  return measureRead("releases.detail", async () => {
    const timing = revealTiming("cms_release_read");
    const { primaryArtist, secondaryArtist, artworkAsset, tracks, ...r } =
      found(
        await prisma.release.findUnique({
          where: { id },
          select: editorSelect.releases,
        }),
      );
    timing.mark("mainAndRelationshipsEndMs");
    const { labels } = await filterOptions(actor, undefined, r.labelId);
    timing.mark("pickerBootstrapEndMs");
    const publishedTracks = new Map<string, string>(
      r.publishedRevision?.tracks.map((t) => [
        t.trackRevision.trackId,
        t.trackRevisionId,
      ]) ?? [],
    );
    const result = {
      release: {
        ...r,
        publishedRevision: r.publishedRevision
          ? {
              id: r.publishedRevision.id,
              revisionNumber: r.publishedRevision.revisionNumber,
              sourceWorkingVersion: r.publishedRevision.sourceWorkingVersion,
            }
          : null,
        trackIds: tracks.map((t) => t.trackId),
        releaseDate: r.releaseDate?.toISOString().slice(0, 10) ?? null,
        scheduledFor: date(r.scheduledFor),
      },
      artists: [primaryArtist, ...(secondaryArtist ? [secondaryArtist] : [])],
      labels,
      tracks: tracks.map(({ track }) => ({
        ...trackChoice(track),
        changedSinceReleasePublication:
          publishedTracks.has(track.id) &&
          publishedTracks.get(track.id) !== track.publishedRevisionId,
      })),
      mediaAssets: artworkAsset ? [artworkAsset] : [],
    };
    timing.mark("dtoEndMs");
    timing.finish();
    return result;
  });
}
