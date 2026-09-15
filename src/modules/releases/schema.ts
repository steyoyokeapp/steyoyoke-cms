import { z } from "zod";
import { ReleaseStatus } from "@/generated/prisma/client";

const httpsUrl = z.union([z.literal(""), z.url().refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS.")]).optional().nullable();
const optionalDate = z.union([z.literal(""), z.iso.date(), z.null()]).optional();

export const releaseDraftSchema = z.object({
  catalogue: z.string().trim().max(100).nullable().optional(),
  trackIds: z.array(z.uuid()).max(500).optional(),
  title: z.string().trim().min(1, "Title is required.").max(255),
  primaryArtistId: z.uuid(),
  secondaryArtistId: z.union([z.uuid(), z.literal(""), z.null()]).optional(),
  labelId: z.uuid(),
  releaseDate: optionalDate,
  spotifyUrl: httpsUrl,
  beatportUrl: httpsUrl,
  traxsourceUrl: httpsUrl,
  bandcampUrl: httpsUrl,
  appleMusicUrl: httpsUrl,
  soundcloudUrl: httpsUrl,
  artworkAssetId: z.union([z.uuid(), z.literal(""), z.null()]).optional(),
}).superRefine((value, context) => {
  if (value.secondaryArtistId && value.primaryArtistId === value.secondaryArtistId) {
    context.addIssue({ code: "custom", path: ["secondaryArtistId"], message: "Secondary Artist must differ from Primary Artist." });
  }
});

export const updateReleaseSchema = releaseDraftSchema.and(z.object({ expectedWorkingVersion: z.number().int().positive() }));
export const publishReleaseSchema = z.object({ expectedWorkingVersion: z.number().int().positive() });
export const scheduleReleaseSchema = publishReleaseSchema.extend({ scheduledFor: z.coerce.date() });
export const replaceReleaseTracksSchema = z.object({ expectedWorkingVersion: z.number().int().positive(), trackIds: z.array(z.uuid()).max(500) });
export const releaseListSchema = z.object({
  q: z.string().trim().max(255).optional(), artistId: z.uuid().optional(), labelId: z.uuid().optional(), status: z.enum(ReleaseStatus).optional(),
});

export function normalizeReleaseTrackIds(input: unknown) {
  const trackIds = z.array(z.uuid()).max(500).parse(input);
  if (new Set(trackIds).size !== trackIds.length) throw new Error("A Track can appear only once in a Release.");
  return trackIds;
}

export function releaseDate(value: string | null | undefined) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

export type ReleaseDraftInput = z.input<typeof releaseDraftSchema>;
