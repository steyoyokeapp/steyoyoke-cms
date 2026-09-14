"use client";

import { useState, type FormEvent } from "react";
import { SearchPicker } from "./search-picker";
import { useRouter } from "next/navigation";
import type { TrackOption } from "@/components/track-create-form";
import { parseDuration } from "@/modules/tracks/duration";

export function PodcastCreateForm({ artists, labels }: { artists: TrackOption[]; labels: TrackOption[] }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [primaryArtistId,setPrimaryArtistId]=useState(""); const [secondaryArtistId,setSecondaryArtistId]=useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/admin/podcasts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: form.get("title"), primaryArtistId: form.get("primaryArtistId"), secondaryArtistId: form.get("secondaryArtistId"), labelId: form.get("labelId"), episodeDate: form.get("episodeDate"), durationMs: parseDuration(String(form.get("duration") ?? "")) }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Could not create Podcast."); router.push(`/admin/podcasts/${body.id}`); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create Podcast."); setPending(false); }
  }
  return <form className="panel editor-form catalogue-editor" onSubmit={submit}><div className="eyebrow">Core</div>
    <label>Title<input name="title" required maxLength={255} autoFocus /></label>
    <SearchPicker kind="artist" label="Primary Artist" name="primaryArtistId" value={primaryArtistId} initial={artists} onChange={setPrimaryArtistId} describe={a=>`${a.name} · #${a.legacyId}`} required/>
    <SearchPicker kind="artist" label="Secondary Artist" name="secondaryArtistId" value={secondaryArtistId} initial={artists} onChange={setSecondaryArtistId} describe={a=>`${a.name} · #${a.legacyId}`} />
    <label>Label<select name="labelId" required defaultValue=""><option value="" disabled>Choose Label</option>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
    <label>Episode Date <span className="hint">Required before publishing</span><input name="episodeDate" type="date" /></label><label>Duration <span className="hint">MM:SS or HH:MM:SS</span><input name="duration" placeholder="58:30" pattern="(?:[0-9]{2}:)?[0-9]{2}:[0-9]{2}" /></label>
    {error && <div className="alert error" role="alert">{error}</div>}<div className="button-row"><button className="button primary" disabled={pending}>{pending ? "Creating…" : "Create draft"}</button></div>
  </form>;
}
