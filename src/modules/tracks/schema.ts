import { z } from "zod";
import { TrackStatus } from "@/generated/prisma/client";

const httpsUrl = z.union([z.literal(""), z.url().refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS.")]).optional().nullable();

export const trackDraftSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(255),
  primaryArtistId: z.uuid(),
  secondaryArtistId: z.union([z.uuid(), z.literal(""), z.null()]).optional(),
  labelId: z.uuid(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  spotifyUrl: httpsUrl,
  beatportUrl: httpsUrl,
  traxsourceUrl: httpsUrl,
  bandcampUrl: httpsUrl,
  appleMusicUrl: httpsUrl,
  soundcloudUrl: httpsUrl,
}).superRefine((value, context) => {
  if (value.secondaryArtistId && value.primaryArtistId === value.secondaryArtistId) {
    context.addIssue({ code: "custom", path: ["secondaryArtistId"], message: "Secondary Artist must differ from Primary Artist." });
  }
});

export const updateTrackSchema = trackDraftSchema.and(z.object({ expectedWorkingVersion: z.number().int().positive() }));
export const publishTrackSchema = z.object({ expectedWorkingVersion: z.number().int().positive() });
export const scheduleTrackSchema = publishTrackSchema.extend({ scheduledFor: z.coerce.date() });
export const trackListSchema = z.object({
  q: z.string().trim().optional(),
  artistId: z.uuid().optional(),
  labelId: z.uuid().optional(),
  status: z.enum(TrackStatus).optional(),
});

export type TrackDraftInput = z.input<typeof trackDraftSchema>;
