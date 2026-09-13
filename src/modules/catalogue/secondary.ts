import { readPermission } from "./browse";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, type Actor } from "@/lib/authorization";
import { catalogueKinds, type CatalogueKind } from "./browse";
export const secondarySchema = z.object({
  kind: z.enum(catalogueKinds),
  id: z.uuid(),
  section: z.enum(["history", "audit", "preview", "snapshot"]),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  revisionId: z.uuid().optional(),
});
const tables = {
  artists: ["artist_revisions", "audit_logs", "artistId", "name"],
  tracks: ["track_revisions", "track_audit_logs", "trackId", "title"],
  podcasts: [
    "podcast_episode_revisions",
    "podcast_audit_logs",
    "episodeId",
    "title",
  ],
  releases: ["release_revisions", "release_audit_logs", "releaseId", "title"],
} as const;
export async function secondaryData(
  actor: Actor,
  input: unknown,
): Promise<unknown> {
  const f = secondarySchema.parse(input);
  const { kind, id, section, page } = f;
  requirePermission(actor, readPermission[kind]);
  if (section === "preview") return preview(actor, kind, id);
  if (section === "snapshot") {
    const revisionId = z.uuid().parse(f.revisionId);
    if (kind === "artists")
      return prisma.artistRevision.findFirstOrThrow({
        where: { id: revisionId, artistId: id },
      });
    if (kind === "tracks")
      return prisma.trackRevision.findFirstOrThrow({
        where: { id: revisionId, trackId: id },
      });
    if (kind === "podcasts")
      return prisma.podcastEpisodeRevision.findFirstOrThrow({
        where: { id: revisionId, episodeId: id },
        include: { chapters: { orderBy: { position: "asc" } } },
      });
    return prisma.releaseRevision.findFirstOrThrow({
      where: { id: revisionId, releaseId: id },
      include: {
        tracks: {
          orderBy: { position: "asc" },
          include: { trackRevision: true },
        },
      },
    });
  }
  // Identifiers come exclusively from the fixed allowlist; values remain SQL parameters.
  const [revisions, audits, fk, title] = tables[kind];
  const table = Prisma.raw(`"${section === "history" ? revisions : audits}"`);
  const field = Prisma.raw(`r."${fk}"`);
  const columns =
    section === "history"
      ? Prisma.sql`r."revisionNumber",r."sourceWorkingVersion",${Prisma.raw(`r."${title}"`)} AS title`
      : Prisma.sql`r.action, (SELECT u.name FROM users u WHERE u.id=r."actorId") AS "actorName"`;
  const rows = await prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>(
    Prisma.sql`SELECT r.id,r."createdAt",${columns} FROM ${table} r WHERE ${field}=${id}::uuid ORDER BY ${section === "history" ? Prisma.sql`r."revisionNumber"` : Prisma.sql`r."createdAt"`} DESC,r.id DESC LIMIT 26 OFFSET ${(page - 1) * 25}`,
  );
  return { items: rows.slice(0, 25), hasMore: rows.length > 25, page };
}
async function preview(actor: Actor, kind: CatalogueKind, id: string) {
  if (kind === "artists") {
    const s = await import("@/modules/artists/service");
    const l = await import("@/modules/artists/legacy");
    const record = await s.getArtist(actor, id);
    return {
      canonical: await s.getArtistPreview(actor, id),
      legacy:
        record.publishedRevision &&
        ["PUBLISHED", "SCHEDULED"].includes(record.status)
          ? l.legacyArtistEnvelope([record])
          : null,
    };
  }
  if (kind === "tracks") {
    const s = await import("@/modules/tracks/service");
    const l = await import("@/modules/tracks/legacy");
    const record = await s.getLegacyTrackPreview(actor, id);
    return {
      canonical: await s.getTrackPreview(actor, id),
      legacy: record?.publishedRevision
        ? {
            tracks: [
              l.serializeLegacyTrack(record.publishedRevision, record.legacyId),
            ],
            base_cover_folder: "/1440/",
            main_cover_folder: "/assets/uploads/files",
          }
        : null,
    };
  }
  if (kind === "podcasts") {
    const s = await import("@/modules/podcasts/service");
    const l = await import("@/modules/podcasts/legacy");
    const record = await s.getLegacyPodcastPreview(actor, id);
    return {
      canonical: await s.getPodcastPreview(actor, id),
      legacy: record?.publishedRevision
        ? {
            tracks: [
              l.serializeLegacyPodcast(
                record.publishedRevision,
                record.legacyId,
              ),
            ],
            base_cover_folder: "/1440/",
            main_cover_folder: "/assets/uploads/files",
          }
        : null,
    };
  }
  const s = await import("@/modules/releases/service");
  const l = await import("@/modules/releases/legacy");
  const record = await s.getRelease(actor, id);
  const published = record.publishedRevision;
  return {
    canonical: s.buildReleasePreview(record),
    legacy: s.buildLegacyReleasePreview(record),
    releasecomplete: published
      ? {
          releasecomplete: {
            "0": l.serializeLegacyRelease(
              published,
              record.legacyId,
              "complete",
            ),
            tracks: published.tracks.map(({ trackRevision }) =>
              l.serializeLegacyReleaseCompleteTrack(
                trackRevision,
                trackRevision.track.legacyId,
              ),
            ),
          },
          base_cover_folder: "/1440/",
          main_cover_folder: "/assets/uploads/files",
        }
      : null,
  };
}
