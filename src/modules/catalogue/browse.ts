import { z } from "zod";
export const catalogueKinds = [
  "artists",
  "tracks",
  "podcasts",
  "releases",
] as const;
export type CatalogueKind = (typeof catalogueKinds)[number];
export const readPermission = {
  artists: "artist:read",
  tracks: "track:read",
  podcasts: "podcast:read",
  releases: "release:read",
} as const;
export const browseSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).catch(1),
  q: z.string().trim().max(200).optional(),
  artistId: z.uuid().optional().or(z.literal("")),
  labelId: z.uuid().optional().or(z.literal("")),
  status: z
    .enum(["DRAFT", "SCHEDULED", "PUBLISHED", "UNPUBLISHED", "ARCHIVED"])
    .optional()
    .or(z.literal("")),
});
export const PAGE_SIZE = 50;
export function listQuery(
  params: Record<string, string | string[] | undefined>,
) {
  return new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      typeof v === "string" &&
      ["q", "artistId", "labelId", "status", "page"].includes(k) &&
      v
        ? [[k, v]]
        : [],
    ),
  );
}
export function safeReturnTo(value: unknown, kind: CatalogueKind) {
  if (typeof value !== "string") return `/admin/${kind}`;
  const base = `/admin/${kind}`;
  return value === base ||
    (value.startsWith(base + "?") && !value.includes("\\"))
    ? value
    : base;
}
