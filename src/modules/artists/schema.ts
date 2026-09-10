import { z } from "zod";

const nullableUrl = z.union([z.literal(""), z.url()]).optional().nullable();

export const artistDraftSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().max(180).optional(),
  shortBio: z.string().trim().max(2_000).optional().nullable(),
  facebookUrl: nullableUrl,
});

export const updateArtistSchema = artistDraftSchema.extend({
  expectedWorkingVersion: z.number().int().positive(),
});

export const scheduleArtistSchema = z.object({
  scheduledFor: z.coerce.date(),
  expectedWorkingVersion: z.number().int().positive(),
});

export const publishArtistSchema = z.object({
  expectedWorkingVersion: z.number().int().positive(),
});

export const artistListSchema = z.object({
  q: z.string().trim().max(160).optional(),
  status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED", "UNPUBLISHED", "ARCHIVED"]).optional(),
});

export type ArtistDraftInput = z.infer<typeof artistDraftSchema>;
