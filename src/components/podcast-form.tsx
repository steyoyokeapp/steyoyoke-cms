"use client";
import "./cms-form-design.css";
import { CmsDatePicker } from "./cms-date-picker";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { TrackOption } from "./track-create-form";
import type { PodcastEditorData } from "./podcast-editor";
import type { AudioOption } from "./audio-picker";
import type { ArtworkOption } from "./artwork-picker";
import { TrackMediaUpload } from "./track-media-upload";
import { TrackArtistCombobox } from "./track-artist-combobox";
import { PodcastChapters } from "./podcast-chapters";
import { formatTracklist, validateTracklist, type TracklistResult } from "@/modules/podcasts/tracklist";

export function PodcastForm({ podcast, artists, labels, role = "EDITOR", mediaAssets = [], audioAssets = [] }: { podcast?: PodcastEditorData; artists: TrackOption[]; labels: TrackOption[]; role?: string; mediaAssets?: ArtworkOption[]; audioAssets?: AudioOption[] }) {
  const router = useRouter(); const dialog = useRef<HTMLDialogElement>(null);
  const canWrite = role !== "VIEWER"; const archived = podcast?.status === "ARCHIVED"; const disabled = !canWrite || archived;
  const [title, setTitle] = useState(podcast?.title ?? ""); const [primary, setPrimary] = useState(podcast?.primaryArtistId ?? ""); const [secondary, setSecondary] = useState(podcast?.secondaryArtistId ?? ""); const [label, setLabel] = useState(podcast?.labelId ?? ""); const [date, setDate] = useState(podcast?.episodeDate ?? "");
  const [audioId, setAudioId] = useState(podcast?.audioAssetId ?? null); const [artworkId, setArtworkId] = useState(podcast?.artworkAssetId ?? null);
  const [tracklist, setTracklist] = useState(() => formatTracklist(podcast?.chapters ?? []));
  const [audioDuration, setAudioDuration] = useState(audioAssets.find(a => a.id === podcast?.audioAssetId)?.durationMs ?? podcast?.durationMs ?? null);
  const [validation, setValidation] = useState<{ text: string; duration: number | null; result: TracklistResult } | null>(null);
  const validationCurrent = validation?.text === tracklist && validation.duration === audioDuration;
  const tracklistReady = !tracklist.trim() || (validationCurrent && validation?.result.errors.length === 0);
  const [pending, setPending] = useState(false); const [audioBusy, setAudioBusy] = useState(false); const [artworkBusy, setArtworkBusy] = useState(false); const [error, setError] = useState(""); const [scheduledFor, setScheduledFor] = useState(""); const [dirty, setDirty] = useState(false);
  const busy = pending || audioBusy || artworkBusy;
  async function request(path: string, method: string, data: unknown) { const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); const result = await r.json(); if (!r.ok) throw new Error(result.error?.message ?? "The operation failed."); return result; }
  async function save(e: FormEvent) {
    e.preventDefault(); setError(""); if (!tracklistReady) return setError("Validate the current tracklist before saving."); if (!primary) return setError("Choose a Primary Artist from the search results."); setPending(true);
    try { const result = await request(podcast ? `/api/admin/podcasts/${podcast.id}` : "/api/admin/podcasts", podcast ? "PATCH" : "POST", { title, primaryArtistId: primary, secondaryArtistId: secondary, labelId: label, episodeDate: date, audioAssetId: audioId, artworkAssetId: artworkId, tracklist, ...(podcast ? { expectedWorkingVersion: podcast.workingVersion } : {}) }); if (podcast) window.location.reload(); else { router.push(`/admin/podcasts/${result.id}`); router.refresh(); } }
    catch (caught) { setError((caught as Error).message); setPending(false); }
  }
  async function perform(action: string, extra: Record<string, unknown> = {}) {
    if (!podcast) return; setError(""); setPending(true);
    try { await request(`/api/admin/podcasts/${podcast.id}/actions`, "POST", { action, ...extra }); if (action === "archive") { router.push("/admin/podcasts"); router.refresh(); } else window.location.reload(); }
    catch (caught) { setError((caught as Error).message); dialog.current?.close(); setPending(false); }
  }
  const initialAudio = audioAssets.map(a => ({ ...a, durationMs: a.durationMs ?? podcast?.durationMs ?? null })).find(a => a.id === podcast?.audioAssetId);
  return <div className="catalogue-editor cms-form-design">
    {podcast && <p className="muted"><span className={`status ${podcast.status.toLowerCase()}`}>{podcast.status}</span>{podcast.publishedRevision && podcast.publishedRevision.sourceWorkingVersion !== podcast.workingVersion ? " · Unpublished changes" : ""}</p>}
    <form className="panel editor-form" onSubmit={save} onChange={() => setDirty(true)}>
      <TrackMediaUpload modern audioProfile="podcast" kind="audio" initial={initialAudio} disabled={disabled || pending} onBusy={setAudioBusy} onReady={a => { setAudioId(a.id); setAudioDuration(a.durationMs ?? null); setDirty(true); }} />
      <section className="track-design-section"><div className="track-section-heading"><h2>Podcast details</h2><p>The episode information listeners will see.</p></div><div className="track-fields-grid">
        <label>Title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="Podcast title" maxLength={255} required readOnly={disabled} /></label>
        <label>Label<select name="labelId" value={label} onChange={e => setLabel(e.target.value)} required disabled={disabled}><option value="" disabled>Choose Label</option>{labels.map(l => <option value={l.id} key={l.id}>{l.name}{l.active === false ? " (inactive · attached)" : ""}</option>)}</select></label>
        <TrackArtistCombobox modern label="Primary Artist" value={primary} initial={artists} onChange={v => { setPrimary(v); setDirty(true); }} disabled={disabled} required />
        <TrackArtistCombobox modern label="Secondary Artist" value={secondary} initial={artists} onChange={v => { setSecondary(v); setDirty(true); }} disabled={disabled} />
        <CmsDatePicker label="Episode Date" value={date ?? ""} onChange={value => { setDate(value); setDirty(true); }} disabled={disabled} />
      </div></section>
      <TrackMediaUpload modern kind="artwork" artworkAlt="Podcast artwork" initial={mediaAssets.find(a => a.id === podcast?.artworkAssetId)} disabled={disabled || pending} onBusy={setArtworkBusy} onReady={a => { setArtworkId(a.id); setDirty(true); }} />
      <PodcastChapters text={tracklist} onChange={v => { setTracklist(v); setDirty(true); }} onValidate={() => setValidation({ text: tracklist, duration: audioDuration, result: validateTracklist(tracklist, audioDuration, podcast?.chapters ?? []) })} result={validation?.result ?? null} current={validationCurrent} disabled={disabled || pending} />
      {error && <p className="alert error" role="alert">{error}</p>}
      {!disabled && <div className="track-save-row"><button className="button primary" disabled={busy || !tracklistReady}>{pending ? "Saving…" : podcast ? "Save changes" : "Create podcast"}</button></div>}
    </form>
    {podcast && canWrite && !archived && <section className="track-design-section publish-panel"><div className="track-section-heading"><h2>Publication</h2><p>{dirty ? "Save your changes before publishing or scheduling." : "Publish this episode now, or choose a release time."}</p></div><div className="button-row wrap">
      <button type="button" className="button" disabled={busy || dirty} onClick={() => perform("publish", { expectedWorkingVersion: podcast.workingVersion })}>Publish now</button>
      {podcast.status === "PUBLISHED" && <button type="button" className="button" disabled={busy} onClick={() => perform("unpublish")}>Unpublish</button>}
      {podcast.status === "SCHEDULED" ? <button type="button" className="button" disabled={busy} onClick={() => perform("cancelSchedule")}>Cancel schedule</button> : <><label>Schedule time<input type="datetime-local" value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} /></label><button type="button" className="button" disabled={busy || dirty || !scheduledFor} onClick={() => perform("schedule", { scheduledFor: new Date(scheduledFor).toISOString(), expectedWorkingVersion: podcast.workingVersion })}>Schedule</button></>}
    </div>{podcast.scheduledFor && <p className="muted">Scheduled for {new Date(podcast.scheduledFor).toLocaleString()}.</p>}</section>}
    {podcast && canWrite && <section className="track-danger-zone"><div><h2>Danger zone</h2><p>{archived ? "This Podcast is archived. Restoring may make a previously published episode visible again." : "Archive this Podcast and remove it from public delivery. Chapters, publication history and audio are preserved."}</p></div>
      <button type="button" className="button danger" disabled={busy} onClick={() => dialog.current?.showModal()}>{archived ? "Restore podcast" : "Delete / archive podcast"}</button>
      <dialog ref={dialog} aria-labelledby="podcast-danger-title"><h2 id="podcast-danger-title">{archived ? "Restore Podcast?" : "Archive Podcast?"}</h2><p>{archived ? "A previously published episode may become publicly visible again." : "This removes the episode from public delivery. Its history and audio will be preserved."}</p><div className="button-row"><button type="button" className="button" disabled={pending} onClick={() => dialog.current?.close()}>Cancel</button><button type="button" className="button danger" disabled={pending} onClick={() => perform(archived ? "restore" : "archive")}>{archived ? "Confirm restore" : "Confirm archive"}</button></div></dialog>
    </section>}
  </div>;
}
