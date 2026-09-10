import { Prisma, ReleaseStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const publishedReleaseWhere: Prisma.ReleaseWhereInput = { publishedRevisionId: { not: null }, status: { in: [ReleaseStatus.PUBLISHED, ReleaseStatus.SCHEDULED] } };

export const publishedReleaseInclude = {
  publishedRevision: { include: { artworkAsset: true, tracks: { include: { trackRevision: { include: { artworkAsset: true, audioAsset: true, track: { select: { legacyId: true } } } } }, orderBy: { position: "asc" as const } } } },
} satisfies Prisma.ReleaseInclude;

export async function listPublishedReleasesForLegacy(limit?: number, offset = 0) {
  const [releases, total] = await prisma.$transaction([
    prisma.release.findMany({ where: publishedReleaseWhere, include: publishedReleaseInclude, orderBy: [{ releaseDate: "desc" }, { legacyId: "desc" }], take: limit, skip: offset }),
    prisma.release.count({ where: publishedReleaseWhere }),
  ]);
  return { releases, total };
}

export async function getPublishedReleaseForLegacy(legacyId: number) {
  return prisma.release.findFirst({ where: { ...publishedReleaseWhere, legacyId }, include: publishedReleaseInclude });
}

export type LegacyReleaseFilter = { artist?: string; releaseTitle?: string; label?: string; trackTitle?: string; limit?: number; offset?: number; paginated: boolean };

export async function queryPublishedReleaseFilter(input: LegacyReleaseFilter) {
  const revisionWhere: Prisma.ReleaseRevisionWhereInput = input.artist
    ? { primaryArtistName: { contains: input.artist, mode: "insensitive" } }
    : input.releaseTitle
      ? { title: { contains: input.releaseTitle, mode: "insensitive" } }
      : input.label
        ? { labelLegacyValue: input.label.toUpperCase() }
        : {};
  const where: Prisma.ReleaseWhereInput = { ...publishedReleaseWhere, publishedRevision: { is: revisionWhere } };
  const total = await prisma.release.count({ where });
  const candidates = await prisma.release.findMany({
    where, include: publishedReleaseInclude,
    orderBy: input.paginated ? [{ releaseDate: "desc" }, { legacyId: "desc" }] : [{ legacyId: "desc" }],
    take: input.paginated ? input.limit : undefined, skip: input.paginated ? input.offset : undefined,
  });
  const needle = input.trackTitle?.toLocaleLowerCase();
  const releases = candidates.flatMap((release) => {
    const matches = release.publishedRevision?.tracks.filter(({ trackRevision }) => !needle || trackRevision.title.toLocaleLowerCase().includes(needle)) ?? [];
    return matches.length ? [{ ...release, legacyTitleTracks: matches.map(({ trackRevision }) => ({ track_title: trackRevision.title, id: String(release.legacyId) })) }] : [];
  });
  return { releases, total };
}

export async function listLegacyReleaseArtists() {
  const releases = await prisma.release.findMany({ where: publishedReleaseWhere, select: { publishedRevision: { select: { primaryArtistName: true } } } });
  return [...new Set(releases.flatMap(({ publishedRevision }) => publishedRevision ? [publishedRevision.primaryArtistName] : []))].sort((a, b) => a.localeCompare(b)).map((artist_name) => ({ artist_name }));
}

export async function listLegacyReleaseTitles() {
  const releases = await prisma.release.findMany({ where: publishedReleaseWhere, select: { publishedRevision: { select: { title: true } } } });
  return [...new Set(releases.flatMap(({ publishedRevision }) => publishedRevision ? [publishedRevision.title] : []))].sort((a, b) => a.localeCompare(b)).map((release_title) => ({ release_title }));
}

export async function listLegacyReleaseTrackTitles() {
  const releases = await prisma.release.findMany({ where: publishedReleaseWhere, select: { publishedRevision: { select: { tracks: { select: { trackRevision: { select: { title: true } } } } } } } });
  return [...new Set(releases.flatMap(({ publishedRevision }) => publishedRevision?.tracks.map(({ trackRevision }) => trackRevision.title) ?? []))].sort((a, b) => a.localeCompare(b)).map((track_title) => ({ track_title }));
}
