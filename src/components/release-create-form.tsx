"use client";
import "./cms-form-design.css";

import { useState, type FormEvent } from "react";
import { TrackArtistCombobox } from "./track-artist-combobox";
import { useRouter } from "next/navigation";

export type ReleaseRelationshipOption = { id: string; name: string; legacyId?: number; active?: boolean };

export function ReleaseCreateForm({ artists, labels }: { artists: ReleaseRelationshipOption[]; labels: ReleaseRelationshipOption[] }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [primaryArtistId,setPrimaryArtistId]=useState(""); const [secondaryArtistId,setSecondaryArtistId]=useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/admin/releases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: form.get("title"), primaryArtistId: form.get("primaryArtistId"), secondaryArtistId: form.get("secondaryArtistId"), labelId: form.get("labelId"), releaseDate: form.get("releaseDate"), spotifyUrl: form.get("spotifyUrl"), beatportUrl: form.get("beatportUrl"), traxsourceUrl: form.get("traxsourceUrl"), bandcampUrl: form.get("bandcampUrl"), appleMusicUrl: form.get("appleMusicUrl"), soundcloudUrl: form.get("soundcloudUrl") }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? "Could not create Release."); router.push(`/admin/releases/${result.id}`); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create Release."); setPending(false); }
  }
  return <form className="panel editor-form catalogue-editor cms-form-design" onSubmit={submit}>
    <section className="track-design-section"><div className="track-section-heading"><h2>Release details</h2></div><div className="track-fields-grid cms-core-grid">
    <label>Title<input placeholder="Release title" name="title" required maxLength={255} autoFocus /></label>

    <label>Label<select name="labelId" required defaultValue=""><option value="" disabled>Choose Label</option>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
    <TrackArtistCombobox modern label="Primary Artist" name="primaryArtistId" value={primaryArtistId} initial={artists} onChange={setPrimaryArtistId} required/>
    <TrackArtistCombobox modern label="Secondary Artist" name="secondaryArtistId" value={secondaryArtistId} initial={artists} onChange={setSecondaryArtistId} />

    <label>Release Date<input name="releaseDate" type="date" /></label>
    </div></section><section className="track-design-section"><div className="track-section-heading"><h2>Store links</h2></div><div className="track-fields-grid">
    <label>Spotify<input name="spotifyUrl" type="url" placeholder="https://syykrec.com/…" /></label><label>Beatport<input name="beatportUrl" type="url" placeholder="https://syykrec.com/…" /></label><label>Traxsource<input name="traxsourceUrl" type="url" placeholder="https://syykrec.com/…" /></label><label>Bandcamp<input name="bandcampUrl" type="url" placeholder="https://syykrec.com/…" /></label><label>Apple Music / iTunes<input name="appleMusicUrl" type="url" placeholder="https://syykrec.com/…" /></label><label>SoundCloud<input name="soundcloudUrl" type="url" placeholder="https://syykrec.com/…" /></label>
    </div></section>{error && <div className="alert error" role="alert">{error}</div>}
    <div className="button-row"><button className="button primary" disabled={pending}>{pending ? "Creating…" : "Create draft"}</button></div>
  </form>;
}
