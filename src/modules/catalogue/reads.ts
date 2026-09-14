import { readPermission } from "./browse";
import { prisma } from "@/lib/prisma";
import { requirePermission, type Actor } from "@/lib/authorization";
import { browseSchema, PAGE_SIZE, type CatalogueKind } from "./browse";
import { measureRead } from "@/lib/read-performance";
const artistSummary = { id: true, name: true, legacyId: true } as const;
const common = {
  id: true,
  legacyId: true,
  title: true,
  status: true,
  workingVersion: true,
  updatedAt: true,
  primaryArtist: { select: { name: true } },
  label: { select: { name: true } },
  publishedRevision: { select: { sourceWorkingVersion: true } },
} as const;
export const listSelect = {
  artists: {
    id: true,
    legacyId: true,
    name: true,
    slug: true,
    status: true,
    workingVersion: true,
    updatedAt: true,
  },
  tracks: { ...common, durationMs: true },
  podcasts: {
    ...common,
    episodeDate: true,
    _count: { select: { chapters: true } },
  },
  releases: {
    ...common,
    releaseDate: true,
    _count: { select: { tracks: true } },
  },
} as const;
export async function cataloguePage(
  actor: Actor,
  kind: CatalogueKind,
  input: unknown = {},
) {
  requirePermission(actor, readPermission[kind]);
  const f = browseSchema.parse(input);
  const artistWhere = {
    ...(f.status ? { status: f.status } : {}),
    ...(f.q
      ? {
          OR: [
            { name: { contains: f.q, mode: "insensitive" as const } },
            { slug: { contains: f.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const where = {
    ...(f.status ? { status: f.status } : kind === "tracks" ? { status: { not: "ARCHIVED" as const } } : {}),
    ...(f.labelId ? { labelId: f.labelId } : {}),
    ...(f.q ? { title: { contains: f.q, mode: "insensitive" as const } } : {}),
    ...(f.artistId
      ? {
          OR: [
            { primaryArtistId: f.artistId },
            { secondaryArtistId: f.artistId },
          ],
        }
      : {}),
  };
  const args = {
    where,
    skip: (f.page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
    orderBy: [{ updatedAt: "desc" as const }, { id: "desc" as const }],
  };
  return measureRead(`${kind}.list`, async () => {
    const items =
      kind === "artists"
        ? await prisma.artist.findMany({
            ...args,
            where: artistWhere,
            select: listSelect.artists,
          })
        : kind === "tracks"
          ? await prisma.track.findMany({ ...args, select: listSelect.tracks })
          : kind === "podcasts"
            ? await prisma.podcastEpisode.findMany({
                ...args,
                select: listSelect.podcasts,
              })
            : await prisma.release.findMany({
                ...args,
                select: listSelect.releases,
              });
    return {
      items: items.slice(0, PAGE_SIZE),
      hasMore: items.length > PAGE_SIZE,
      page: f.page,
      limit: PAGE_SIZE,
    };
  });
}
export async function filterOptions(
  actor: Actor,
  selectedArtistId?: string,
  selectedLabelId?: string,
) {
  requirePermission(actor, "artist:read");
  const [artists, labels] = await Promise.all([
    selectedArtistId
      ? prisma.artist.findMany({
          where: { id: selectedArtistId },
          select: artistSummary,
          take: 1,
        })
      : Promise.resolve([]),
    prisma.label.findMany({
      where: {
        OR: [
          { active: true },
          ...(selectedLabelId ? [{ id: selectedLabelId }] : []),
        ],
      },
      select: { id: true, name: true, active: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);
  return { artists, labels };
}
