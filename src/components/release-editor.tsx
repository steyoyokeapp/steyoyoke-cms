"use client";
import { ReleaseForm } from "./release-form";
import type { ArtworkOption } from "./artwork-picker";
type Revision = { id:string; revisionNumber:number; sourceWorkingVersion:number };
export type ReleaseTrackOption = { id: string; title: string; legacyId: number; status: string; primaryArtistName: string; labelName: string; publishedRevisionId: string | null; publishedRevisionNumber: number | null; changedSinceReleasePublication?:boolean };
export type ReleaseArtistOption = { id: string; name: string; legacyId: number };
export type ReleaseLabelOption = { id: string; name: string; active?: boolean };
export type ReleaseEditorData = {
  id: string; legacyId: number; title: string; catalogue: string | null; primaryArtistId: string; secondaryArtistId: string | null; labelId: string; releaseDate: string | null;
  spotifyUrl: string | null; beatportUrl: string | null; traxsourceUrl: string | null; bandcampUrl: string | null; appleMusicUrl: string | null; soundcloudUrl: string | null;
  artworkAssetId: string | null; status: string; workingVersion: number; scheduledFor: string | null; publishedRevision: Revision | null; scheduledRevision: Revision | null;
  trackIds: string[];
};

export function ReleaseEditor(props: { release: ReleaseEditorData; role: string; artists: ReleaseArtistOption[]; labels: ReleaseLabelOption[]; tracks: ReleaseTrackOption[]; mediaAssets: ArtworkOption[] }) { return <ReleaseForm {...props} />; }
