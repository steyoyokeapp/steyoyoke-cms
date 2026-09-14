"use client";
import { PodcastForm } from "./podcast-form";
import type { TrackOption } from "./track-create-form";
export function PodcastCreateForm(props: { artists: TrackOption[]; labels: TrackOption[] }) { return <PodcastForm {...props} />; }
