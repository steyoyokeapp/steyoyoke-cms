"use client";
import type { TrackOption } from "./track-create-form";
import type { ArtworkOption } from "./artwork-picker";
import type { AudioOption } from "./audio-picker";
import { TrackForm } from "./track-form";
type Revision = { id:string; revisionNumber:number; sourceWorkingVersion:number };
export type TrackEditorData = {
  id: string; legacyId: number; title: string; primaryArtistId: string; secondaryArtistId: string | null; labelId: string;
  durationMs: number | null; spotifyUrl: string | null; beatportUrl: string | null; traxsourceUrl: string | null;
  bandcampUrl: string | null; appleMusicUrl: string | null; soundcloudUrl: string | null; artworkAssetId: string | null; audioAssetId: string | null; status: string; workingVersion: number;
  scheduledFor: string | null; publishedRevision: Revision | null; scheduledRevision: Revision | null;
};

export function TrackEditor(props: { track: TrackEditorData; role: string; artists: TrackOption[]; labels: TrackOption[]; mediaAssets: ArtworkOption[]; audioAssets: AudioOption[] }) {
  return <TrackForm {...props} />;
}
