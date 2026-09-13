"use client";

import { useState, type FormEvent } from "react";
import { SearchPicker } from "./search-picker";
import { useRouter } from "next/navigation";
import { parseDuration } from "@/modules/tracks/duration";

export type TrackOption = { id: string; name: string; legacyId?: number; active?: boolean };

export function TrackCreateForm({ artists, labels }: { artists: TrackOption[]; labels: TrackOption[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [primaryArtistId,setPrimaryArtistId]=useState(""); const [secondaryArtistId,setSecondaryArtistId]=useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); const form = new FormData(event.currentTarget);
    try {
      const durationMs = parseDuration(String(form.get("duration") ?? ""));
      const response = await fetch("/api/admin/tracks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: form.get("title"), primaryArtistId: form.get("primaryArtistId"), secondaryArtistId: form.get("secondaryArtistId"), labelId: form.get("labelId"), durationMs, spotifyUrl: form.get("spotifyUrl"), beatportUrl: form.get("beatportUrl"), traxsourceUrl: form.get("traxsourceUrl"), bandcampUrl: form.get("bandcampUrl"), appleMusicUrl: form.get("appleMusicUrl"), soundcloudUrl: form.get("soundcloudUrl") }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? "Could not create Track.");
      router.push(`/admin/tracks/${result.id}`); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create Track."); setPending(false); }
  }
  return <form className="panel editor-form" onSubmit={submit}>
    <div className="eyebrow">Core</div>
    <label>Title<input name="title" required maxLength={255} autoFocus /></label>

    <SearchPicker kind="artist" label="Primary Artist" name="primaryArtistId" value={primaryArtistId} initial={artists} onChange={setPrimaryArtistId} describe={a=>`${a.name} · #${a.legacyId}`} required/>
    <SearchPicker kind="artist" label="Secondary Artist" name="secondaryArtistId" value={secondaryArtistId} initial={artists} onChange={setSecondaryArtistId} describe={a=>`${a.name} · #${a.legacyId}`} />
    <label>Label<select name="labelId" required defaultValue=""><option value="" disabled>Choose Label</option>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
    <label>Duration <span className="hint">MM:SS or HH:MM:SS</span><input name="duration" placeholder="03:45" pattern="(?:[0-9]{2}:)?[0-9]{2}:[0-9]{2}" /></label>
    <div className="eyebrow section-break">Links</div>
    <label>Spotify<input name="spotifyUrl" type="url" placeholder="https://" /></label><label>Beatport<input name="beatportUrl" type="url" placeholder="https://" /></label><label>Traxsource<input name="traxsourceUrl" type="url" placeholder="https://" /></label><label>Bandcamp<input name="bandcampUrl" type="url" placeholder="https://" /></label><label>Apple Music / iTunes<input name="appleMusicUrl" type="url" placeholder="https://" /></label><label>SoundCloud<input name="soundcloudUrl" type="url" placeholder="https://" /></label>
    {error && <div className="alert error" role="alert">{error}</div>}
    <div className="button-row"><button className="button primary" disabled={pending}>{pending ? "Creating…" : "Create draft"}</button></div>
  </form>;
}
