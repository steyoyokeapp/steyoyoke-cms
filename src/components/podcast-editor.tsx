"use client";
import "./cms-form-design.css";

import { useState, type DragEvent, type FormEvent } from "react";
import type { TrackOption } from "@/components/track-create-form";
import { formatDuration, parseDuration } from "@/modules/tracks/duration";
import { SecondarySections } from "./secondary-sections";
import { TrackArtistCombobox } from "./track-artist-combobox";
import { ArtworkPicker, type ArtworkOption } from "@/components/artwork-picker";
import { AudioPicker, type AudioOption } from "@/components/audio-picker";

export type PodcastChapterData = { id?: string; artist: string; title: string; legacyReference: string | null; durationMs: number | null };
type Revision = { id:string; revisionNumber:number; sourceWorkingVersion:number };
export type PodcastEditorData = {
  id: string; legacyId: number; title: string; primaryArtistId: string; secondaryArtistId: string | null; labelId: string; episodeDate: string; durationMs: number | null;
  artworkAssetId: string | null; audioAssetId: string | null; status: string; workingVersion: number; scheduledFor: string | null; chapters: PodcastChapterData[]; publishedRevision: Revision | null; scheduledRevision: Revision | null;
};
type EditableChapter = { key: string; artist: string; title: string; legacyReference: string; duration: string };
const displayDate = (value: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
async function readResult(response: Response) { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "The operation failed."); return body; }

export function PodcastEditor({ podcast, role, artists, labels, mediaAssets, audioAssets }: { podcast: PodcastEditorData; role: string; artists: TrackOption[]; labels: TrackOption[]; mediaAssets: ArtworkOption[]; audioAssets: AudioOption[] }) {
  const canWrite = role !== "VIEWER"; const [pending, setPending] = useState(false); const [error, setError] = useState("");  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [title, setTitle] = useState(podcast.title); const [primaryArtistId, setPrimaryArtistId] = useState(podcast.primaryArtistId); const [secondaryArtistId, setSecondaryArtistId] = useState(podcast.secondaryArtistId ?? ""); const [labelId, setLabelId] = useState(podcast.labelId); const [episodeDate, setEpisodeDate] = useState(podcast.episodeDate); const [duration, setDuration] = useState(formatDuration(podcast.durationMs) ?? ""); const [scheduledFor, setScheduledFor] = useState("");
  const [artworkAssetId, setArtworkAssetId] = useState<string | null>(podcast.artworkAssetId);
  const [audioAssetId, setAudioAssetId] = useState<string | null>(podcast.audioAssetId);
  const [chapters, setChapters] = useState<EditableChapter[]>(podcast.chapters.map((chapter) => ({ key: chapter.id ?? crypto.randomUUID(), artist: chapter.artist, title: chapter.title, legacyReference: chapter.legacyReference ?? "", duration: formatDuration(chapter.durationMs) ?? "" })));
  const unpublishedChanges=!podcast.publishedRevision||podcast.publishedRevision.sourceWorkingVersion!==podcast.workingVersion;
  function patchChapter(index: number, patch: Partial<EditableChapter>) { setChapters((current) => current.map((chapter, chapterIndex) => chapterIndex === index ? { ...chapter, ...patch } : chapter)); }
  function moveChapter(from: number, to: number) { if (to < 0 || to >= chapters.length || from === to) return; setChapters((current) => { const next = [...current]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved!); return next; }); }
  function dropChapter(event: DragEvent, to: number) { event.preventDefault(); if (dragIndex !== null) moveChapter(dragIndex, to); setDragIndex(null); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const core = await readResult(await fetch(`/api/admin/podcasts/${podcast.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, primaryArtistId, secondaryArtistId, labelId, episodeDate, durationMs: parseDuration(duration), artworkAssetId, audioAssetId, expectedWorkingVersion: podcast.workingVersion }) }));
      await readResult(await fetch(`/api/admin/podcasts/${podcast.id}/chapters`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedWorkingVersion: core.workingVersion, chapters: chapters.map((chapter, position) => ({ position, artist: chapter.artist, title: chapter.title, legacyReference: chapter.legacyReference, durationMs: parseDuration(chapter.duration) })) }) })); window.location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save Podcast draft."); setPending(false); }
  }
  async function perform(action: string, extra: Record<string, unknown> = {}) {
    setPending(true); setError(""); try { await readResult(await fetch(`/api/admin/podcasts/${podcast.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) })); window.location.reload(); } catch (caught) { setError(caught instanceof Error ? caught.message : "The operation failed."); setPending(false); }
  }
  return <div className="editor-grid catalogue-editor cms-form-design"><div className="editor-column">
    <section className="panel summary-strip"><span><small>Legacy ID</small><strong className="mono">{podcast.legacyId}</strong></span><span><small>Status</small><i className={`status ${podcast.status.toLowerCase()}`}>{podcast.status}</i></span><span><small>Working version</small><strong className="mono">v{podcast.workingVersion}</strong></span><span><small>Published revision</small><strong className="mono">{podcast.publishedRevision ? `r${podcast.publishedRevision.revisionNumber}` : "—"}</strong></span></section>
    {podcast.publishedRevision && <div className={`change-indicator ${unpublishedChanges ? "changed" : "synced"}`}>{unpublishedChanges ? "Unpublished changes" : "Draft matches published revision"}</div>}
    <form className="panel editor-form" onSubmit={save}><section className="track-design-section"><div className="track-section-heading"><h2>Podcast details</h2></div><div className="track-fields-grid cms-core-grid">
      <label>Title<input placeholder="Podcast title" value={title} onChange={(event) => setTitle(event.target.value)} readOnly={!canWrite} required /></label><label>Label<select value={labelId} onChange={(event) => setLabelId(event.target.value)} disabled={!canWrite}>{labels.map((item) => <option key={item.id} value={item.id}>{item.name}{item.active === false ? " (inactive · attached)" : ""}</option>)}</select></label>
    <TrackArtistCombobox modern label="Primary Artist" value={primaryArtistId} initial={artists} onChange={setPrimaryArtistId} disabled={!canWrite} required/>
      <TrackArtistCombobox modern label="Secondary Artist" value={secondaryArtistId} initial={artists} onChange={setSecondaryArtistId} disabled={!canWrite}/>

      <label>Episode Date<input aria-label="Episode Date" type="date" value={episodeDate} onChange={(event) => setEpisodeDate(event.target.value)} readOnly={!canWrite} /></label><label>Duration <span className="hint">MM:SS or HH:MM:SS</span><input value={duration} onChange={(event) => setDuration(event.target.value)} readOnly={!canWrite} placeholder="58:30" pattern="(?:[0-9]{2}:)?[0-9]{2}:[0-9]{2}" /></label>
      </div></section><section className="track-design-section"><div className="section-heading"><div><div className="eyebrow">Chapters</div><p className="muted">Optional, structured, zero-based, and frozen with each publication.</p></div>{canWrite && <button type="button" className="button" onClick={() => setChapters([...chapters, { key: crypto.randomUUID(), artist: "", title: "", legacyReference: "", duration: "" }])}>Add Chapter</button>}</div>
      <div className="chapter-list">{chapters.length === 0 && <p className="empty-inline">No chapters.</p>}{chapters.map((chapter, index) => <div className="chapter-row" key={chapter.key} draggable={canWrite} onDragStart={() => setDragIndex(index)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropChapter(event, index)}>
        <button type="button" className="drag-handle" aria-label={`Drag Chapter ${index + 1}`} disabled={!canWrite}>☰</button><strong className="mono">{index}</strong>
        <label>Artist<input aria-label={`Chapter ${index + 1} Artist`} value={chapter.artist} onChange={(event) => patchChapter(index, { artist: event.target.value })} readOnly={!canWrite} required /></label><label>Title<input aria-label={`Chapter ${index + 1} Title`} value={chapter.title} onChange={(event) => patchChapter(index, { title: event.target.value })} readOnly={!canWrite} required /></label>
        <label>Legacy Reference<input aria-label={`Chapter ${index + 1} Legacy Reference`} value={chapter.legacyReference} onChange={(event) => patchChapter(index, { legacyReference: event.target.value })} readOnly={!canWrite} /></label><label>Duration<input aria-label={`Chapter ${index + 1} Duration`} value={chapter.duration} onChange={(event) => patchChapter(index, { duration: event.target.value })} readOnly={!canWrite} placeholder="03:45" pattern="(?:[0-9]{2}:)?[0-9]{2}:[0-9]{2}" /></label>
        {canWrite && <div className="chapter-actions"><button type="button" aria-label={`Move Chapter ${index + 1} up`} disabled={index === 0} onClick={() => moveChapter(index, index - 1)}>↑</button><button type="button" aria-label={`Move Chapter ${index + 1} down`} disabled={index === chapters.length - 1} onClick={() => moveChapter(index, index + 1)}>↓</button><button type="button" aria-label={`Remove Chapter ${index + 1}`} onClick={() => setChapters(chapters.filter((_, current) => current !== index))}>Remove</button></div>}
      </div>)}</div>
      </section>{error && <div className="alert error" role="alert">{error}</div>}{canWrite && podcast.status !== "ARCHIVED" && <div className="button-row"><button className="button primary" disabled={pending}>Save Draft</button></div>}
    </form>
    <ArtworkPicker value={artworkAssetId} assets={mediaAssets} canWrite={canWrite && podcast.status !== "ARCHIVED"} requiredForPublish onChange={setArtworkAssetId} />
    <AudioPicker value={audioAssetId} assets={audioAssets} canWrite={canWrite && podcast.status !== "ARCHIVED"} requiredForPublish onChange={setAudioAssetId} />
    {canWrite && <section className="panel publish-panel"><h2>Publication</h2><p className="muted">Save first. Publish and schedule freeze the core record and ordered chapters together.</p><div className="button-row wrap">
      {podcast.status !== "ARCHIVED" && <button className="button" disabled={pending} onClick={() => perform("publish", { expectedWorkingVersion: podcast.workingVersion })}>Publish now</button>}{podcast.status === "PUBLISHED" && <button className="button" disabled={pending} onClick={() => perform("unpublish")}>Unpublish</button>}
      {podcast.status !== "ARCHIVED" && podcast.status !== "SCHEDULED" && <><input aria-label="Schedule time" type="datetime-local" value={scheduledFor} onInput={(event) => setScheduledFor(event.currentTarget.value)} /><button className="button" disabled={pending || !scheduledFor} onClick={() => perform("schedule", { scheduledFor: new Date(scheduledFor).toISOString(), expectedWorkingVersion: podcast.workingVersion })}>Schedule</button></>}
      {podcast.status === "SCHEDULED" && <button className="button" disabled={pending} onClick={() => perform("cancelSchedule")}>Cancel schedule</button>}{podcast.status === "ARCHIVED" ? <button className="button" disabled={pending} onClick={() => perform("restore")}>Restore</button> : <button className="button danger" disabled={pending} onClick={() => perform("archive")}>Archive</button>}
    </div>{podcast.scheduledFor && <p className="schedule-note">Scheduled for {displayDate(podcast.scheduledFor)} UTC.</p>}</section>}
  </div><SecondarySections kind="podcasts" id={podcast.id} version={podcast.workingVersion} />
  </div>;
}
