import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission, type Actor } from "@/lib/authorization";
export const PICKER_LIMIT = 25;
export const pickerSchema = z.object({
  kind: z.enum(["artist", "artist-filter", "track", "IMAGE", "AUDIO"]),
  q: z.string().trim().max(200).default(""),
});
export async function searchChoices(actor: Actor, input: unknown) {
  const { kind, q } = pickerSchema.parse(input);
  const idQuery = z.uuid().safeParse(q).success ? [{ id: q }] : [];
  if (kind === "artist" || kind === "artist-filter") {
    requirePermission(actor, "artist:read");
    return prisma.artist.findMany({
      where: {
        ...(kind === "artist"
          ? {
              status: {
                in: ["PUBLISHED", "SCHEDULED"] as ("PUBLISHED" | "SCHEDULED")[],
              },
              publishedRevisionId: { not: null },
            }
          : {}),
        ...(q
          ? {
              OR: [
                ...idQuery,
                { name: { contains: q, mode: "insensitive" } },
                { slug: { contains: q, mode: "insensitive" } },
                ...(Number.isSafeInteger(Number(q))
                  ? [{ legacyId: Number(q) }]
                  : []),
              ],
            }
          : {}),
      },
      select: { id: true, name: true, legacyId: true },
      take: PICKER_LIMIT,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }
  if (kind === "track") {
    requirePermission(actor, "track:read");
    const rows = await prisma.track.findMany({
      where: {
        status: { not: "ARCHIVED" },
        ...(q
          ? {
              OR: [
                ...idQuery,
                { title: { contains: q, mode: "insensitive" } },
                {
                  primaryArtist: { name: { contains: q, mode: "insensitive" } },
                },
                ...(Number.isSafeInteger(Number(q))
                  ? [{ legacyId: Number(q) }]
                  : []),
              ],
            }
          : {}),
      },
      select: trackChoiceSelect,
      take: PICKER_LIMIT,
      orderBy: [{ title: "asc" }, { id: "asc" }],
    });
    return rows.map(trackChoice);
  }
  requirePermission(actor, "media:read");
  return prisma.mediaAsset.findMany({
    where: {
      kind,
      status: "READY",
      ...(q
        ? {
            OR: [
              ...idQuery,
              { originalFilename: { contains: q, mode: "insensitive" } },
              { legacyAudioId: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: mediaChoiceSelect,
    take: PICKER_LIMIT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
export const mediaChoiceSelect = {
  id: true,
  originalFilename: true,
  compatibilityFilename: true,
  width: true,
  height: true,
  status: true,
  legacyAudioId: true,
  durationMs: true,
} as const;
export const trackChoiceSelect = {
  id: true,
  title: true,
  legacyId: true,
  status: true,
  publishedRevisionId: true,
  primaryArtist: { select: { name: true } },
  label: { select: { name: true } },
  publishedRevision: {
    select: { revisionNumber: true, primaryArtistName: true },
  },
} as const;
export function trackChoice(t: {
  id: string;
  title: string;
  legacyId: number;
  status: string;
  publishedRevisionId: string | null;
  primaryArtist: { name: string };
  label: { name: string };
  publishedRevision: {
    revisionNumber: number;
    primaryArtistName: string;
  } | null;
}) {
  return {
    id: t.id,
    title: t.title,
    legacyId: t.legacyId,
    status: t.status,
    publishedRevisionId: t.publishedRevisionId,
    primaryArtistName:
      t.publishedRevision?.primaryArtistName ?? t.primaryArtist.name,
    labelName: t.label.name,
    publishedRevisionNumber: t.publishedRevision?.revisionNumber ?? null,
  };
}
