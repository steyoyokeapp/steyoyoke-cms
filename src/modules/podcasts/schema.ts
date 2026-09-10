import { z } from "zod";
import { PodcastStatus } from "@/generated/prisma/client";

const optionalDate = z.union([z.literal(""), z.iso.date(), z.null()]).optional();

export const podcastDraftSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(255),
  primaryArtistId: z.uuid(),
  secondaryArtistId: z.union([z.uuid(), z.literal(""), z.null()]).optional(),
  labelId: z.uuid(),
  episodeDate: optionalDate,
  durationMs: z.number().int().nonnegative().nullable().optional(),
  artworkAssetId: z.union([z.uuid(), z.literal(""), z.null()]).optional(),
  audioAssetId: z.union([z.uuid(), z.literal(""), z.null()]).optional(),
}).superRefine((value, context) => {
  if (value.secondaryArtistId && value.primaryArtistId === value.secondaryArtistId) {
    context.addIssue({ code: "custom", path: ["secondaryArtistId"], message: "Secondary Artist must differ from Primary Artist." });
  }
});

export const updatePodcastSchema = podcastDraftSchema.and(z.object({ expectedWorkingVersion: z.number().int().positive() }));
export const publishPodcastSchema = z.object({ expectedWorkingVersion: z.number().int().positive() });
export const schedulePodcastSchema = publishPodcastSchema.extend({ scheduledFor: z.coerce.date() });
export const podcastListSchema = z.object({
  q: z.string().trim().max(255).optional(), artistId: z.uuid().optional(), labelId: z.uuid().optional(), status: z.enum(PodcastStatus).optional(),
});

export const podcastChapterSchema = z.object({
  id: z.uuid().optional(),
  position: z.number().int().nonnegative().optional(),
  artist: z.string().trim().min(1, "Chapter Artist is required.").max(255),
  title: z.string().trim().min(1, "Chapter title is required.").max(255),
  legacyReference: z.string().trim().max(255).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
});

export const replacePodcastChaptersSchema = z.object({
  expectedWorkingVersion: z.number().int().positive(), chapters: z.array(podcastChapterSchema).max(500),
});

export function normalizePodcastChapters(input: unknown) {
  const chapters = z.array(podcastChapterSchema).max(500).parse(input);
  return chapters.map((chapter, position) => ({
    position, artist: chapter.artist, title: chapter.title,
    legacyReference: chapter.legacyReference?.trim() || null, durationMs: chapter.durationMs ?? null,
  }));
}

export function podcastDate(value: string | null | undefined) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

export type PodcastDraftInput = z.input<typeof podcastDraftSchema>;
