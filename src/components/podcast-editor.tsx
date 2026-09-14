"use client";
import { PodcastForm } from "./podcast-form";
import type { TrackOption } from "./track-create-form";
import type { ArtworkOption } from "./artwork-picker";
import type { AudioOption } from "./audio-picker";
export type PodcastChapterData = { id?: string; artist: string; title: string; legacyReference: string | null; durationMs: number | null };
type Revision = { id:string; revisionNumber:number; sourceWorkingVersion:number };
export type PodcastEditorData = {
  id: string; legacyId: number; title: string; primaryArtistId: string; secondaryArtistId: string | null; labelId: string; episodeDate: string; durationMs: number | null;
  artworkAssetId: string | null; audioAssetId: string | null; status: string; workingVersion: number; scheduledFor: string | null; chapters: PodcastChapterData[]; publishedRevision: Revision | null; scheduledRevision: Revision | null;
};

export function PodcastEditor(props: { podcast: PodcastEditorData; role: string; artists: TrackOption[]; labels: TrackOption[]; mediaAssets: ArtworkOption[]; audioAssets: AudioOption[] }) { return <PodcastForm {...props} />; }
