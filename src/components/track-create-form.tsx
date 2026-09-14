"use client";
import { TrackForm } from "./track-form";
export type TrackOption = { id: string; name: string; legacyId?: number; active?: boolean };
export function TrackCreateForm({ artists, labels }: { artists: TrackOption[]; labels: TrackOption[] }) {
  return <TrackForm artists={artists} labels={labels} role="EDITOR" />;
}
