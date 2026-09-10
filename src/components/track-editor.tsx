"use client";

import { useMemo, useState, type FormEvent } from "react";
import { formatDuration, parseDuration } from "@/modules/tracks/duration";
import type { TrackOption } from "@/components/track-create-form";
import { ArtworkPicker, type ArtworkOption } from "@/components/artwork-picker";

type Revision = { id: string; revisionNumber: number; sourceWorkingVersion: number; title: string; primaryArtistName: string; labelName: string; createdAt: string };
type Audit = { id: string; action: string; createdAt: string; actor: { name: string } | null };
export type TrackEditorData = {
  id: string; legacyId: number; title: string; primaryArtistId: string; secondaryArtistId: string | null; labelId: string;
  durationMs: number | null; spotifyUrl: string | null; beatportUrl: string | null; traxsourceUrl: string | null;
  bandcampUrl: string | null; appleMusicUrl: string | null; soundcloudUrl: string | null; artworkAssetId: string | null; status: string; workingVersion: number;
  scheduledFor: string | null; publishedRevision: Revision | null; scheduledRevision: Revision | null; revisions: Revision[]; auditLogs: Audit[];
};

async function result(response: Response) { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "The operation failed."); return body; }
const displayDate = (value: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));

export function TrackEditor({ track, role, artists, labels, mediaAssets, legacyPreview }: { track: TrackEditorData; role: string; artists: TrackOption[]; labels: TrackOption[]; mediaAssets: ArtworkOption[]; legacyPreview: unknown }) {
  const canWrite = role !== "VIEWER"; const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [artistQuery, setArtistQuery] = useState("");
  const [title, setTitle] = useState(track.title); const [primaryArtistId, setPrimaryArtistId] = useState(track.primaryArtistId); const [secondaryArtistId, setSecondaryArtistId] = useState(track.secondaryArtistId ?? ""); const [labelId, setLabelId] = useState(track.labelId); const [duration, setDuration] = useState(formatDuration(track.durationMs) ?? ""); const [scheduledFor, setScheduledFor] = useState("");
  const [links, setLinks] = useState({ spotifyUrl: track.spotifyUrl ?? "", beatportUrl: track.beatportUrl ?? "", traxsourceUrl: track.traxsourceUrl ?? "", bandcampUrl: track.bandcampUrl ?? "", appleMusicUrl: track.appleMusicUrl ?? "", soundcloudUrl: track.soundcloudUrl ?? "" });
  const [artworkAssetId, setArtworkAssetId] = useState<string | null>(track.artworkAssetId);
  const shownArtists = useMemo(() => artists.filter((artist) => artist.name.toLowerCase().includes(artistQuery.toLowerCase()) || artist.id === primaryArtistId || artist.id === secondaryArtistId), [artists, artistQuery, primaryArtistId, secondaryArtistId]);
  const primary = artists.find(({ id }) => id === primaryArtistId); const secondary = artists.find(({ id }) => id === secondaryArtistId); const label = labels.find(({ id }) => id === labelId);
  const unpublishedChanges = !track.publishedRevision || track.publishedRevision.sourceWorkingVersion !== track.workingVersion;
  const selectedArtwork = mediaAssets.find(({ id }) => id === artworkAssetId); const canonicalPreview = { id: track.id, legacyId: track.legacyId, title, artists: { primary: primary ? { id: primary.id, name: primary.name } : null, secondary: secondary ? { id: secondary.id, name: secondary.name } : null }, label: label ? { id: label.id, name: label.name } : null, durationMs: (() => { try { return parseDuration(duration); } catch { return "invalid"; } })(), artwork: selectedArtwork ? { mediaAssetId: selectedArtwork.id, status: selectedArtwork.status, dimensions: `${selectedArtwork.width}×${selectedArtwork.height}`, preview: `/assets/uploads/files/${selectedArtwork.compatibilityFilename}` } : null, links: Object.fromEntries(Object.entries(links).map(([key, value]) => [key, value || null])), workflow: { status: track.status, scheduledFor: track.scheduledFor }, workingVersion: track.workingVersion };

  async function perform(action: string, extra: Record<string, unknown> = {}) {
    setPending(true); setError("");
    try { await result(await fetch(`/api/admin/tracks/${track.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) })); window.location.reload(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The operation failed."); setPending(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      await result(await fetch(`/api/admin/tracks/${track.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, primaryArtistId, secondaryArtistId, labelId, durationMs: parseDuration(duration), artworkAssetId, ...links, expectedWorkingVersion: track.workingVersion }) })); window.location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save draft."); setPending(false); }
  }
  return <div className="editor-grid">
    <div className="editor-column">
      <section className="panel summary-strip"><span><small>Legacy ID</small><strong className="mono">{track.legacyId}</strong></span><span><small>Status</small><i className={`status ${track.status.toLowerCase()}`}>{track.status}</i></span><span><small>Working version</small><strong className="mono">v{track.workingVersion}</strong></span><span><small>Published revision</small><strong className="mono">{track.publishedRevision ? `r${track.publishedRevision.revisionNumber}` : "—"}</strong></span></section>
      {track.publishedRevision && <div className={`change-indicator ${unpublishedChanges ? "changed" : "synced"}`}>{unpublishedChanges ? "Unpublished changes" : "Draft matches published revision"}</div>}
      <form className="panel editor-form" onSubmit={save}>
        <div className="eyebrow">Core</div>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} readOnly={!canWrite} required /></label>
        <label>Search Artists<input value={artistQuery} onChange={(event) => setArtistQuery(event.target.value)} readOnly={!canWrite} placeholder="Filter picker" /></label>
        <label>Primary Artist<select value={primaryArtistId} onChange={(event) => setPrimaryArtistId(event.target.value)} disabled={!canWrite}>{shownArtists.map((artist) => <option key={artist.id} value={artist.id}>{artist.name} · #{artist.legacyId}</option>)}</select></label>
        <label>Secondary Artist<select value={secondaryArtistId} onChange={(event) => setSecondaryArtistId(event.target.value)} disabled={!canWrite}><option value="">None</option>{shownArtists.map((artist) => <option key={artist.id} value={artist.id}>{artist.name} · #{artist.legacyId}</option>)}</select></label>
        <label>Label<select value={labelId} onChange={(event) => setLabelId(event.target.value)} disabled={!canWrite}>{labels.map((item) => <option key={item.id} value={item.id}>{item.name}{item.active === false ? " (inactive · attached)" : ""}</option>)}</select></label>
        <label>Duration <span className="hint">MM:SS or HH:MM:SS</span><input value={duration} onChange={(event) => setDuration(event.target.value)} readOnly={!canWrite} placeholder="03:45" pattern="(?:[0-9]{2}:)?[0-9]{2}:[0-9]{2}" /></label>
        <div className="eyebrow section-break">Links</div>
        {([['spotifyUrl','Spotify'],['beatportUrl','Beatport'],['traxsourceUrl','Traxsource'],['bandcampUrl','Bandcamp'],['appleMusicUrl','Apple Music / iTunes'],['soundcloudUrl','SoundCloud']] as const).map(([key, name]) => <label key={key}>{name}<input type="url" value={links[key]} onChange={(event) => setLinks({ ...links, [key]: event.target.value })} readOnly={!canWrite} placeholder="https://" /></label>)}
        {error && <div className="alert error" role="alert">{error}</div>}
        {canWrite && track.status !== "ARCHIVED" && <div className="button-row"><button className="button primary" disabled={pending}>Save draft</button></div>}
      </form>
      <ArtworkPicker value={artworkAssetId} assets={mediaAssets} canWrite={canWrite && track.status !== "ARCHIVED"} onChange={setArtworkAssetId} />
      {canWrite && <section className="panel publish-panel"><h2>Publication</h2><p className="muted">Publishing and scheduling freeze the current draft, Artist delivery names, and Label legacy value.</p><div className="button-row wrap">
        {track.status !== "ARCHIVED" && <button className="button" disabled={pending} onClick={() => perform("publish", { expectedWorkingVersion: track.workingVersion })}>Publish now</button>}
        {track.status === "PUBLISHED" && <button className="button" disabled={pending} onClick={() => perform("unpublish")}>Unpublish</button>}
        {track.status !== "ARCHIVED" && track.status !== "SCHEDULED" && <><input aria-label="Schedule time" type="datetime-local" value={scheduledFor} onInput={(event) => setScheduledFor(event.currentTarget.value)} /><button className="button" disabled={pending || !scheduledFor} onClick={() => perform("schedule", { scheduledFor: new Date(scheduledFor).toISOString(), expectedWorkingVersion: track.workingVersion })}>Schedule</button></>}
        {track.status === "SCHEDULED" && <button className="button" disabled={pending} onClick={() => perform("cancelSchedule")}>Cancel schedule</button>}
        {track.status === "ARCHIVED" ? <button className="button" disabled={pending} onClick={() => perform("restore")}>Restore</button> : <button className="button danger" disabled={pending} onClick={() => perform("archive")}>Archive</button>}
      </div>{track.scheduledFor && <p className="schedule-note">Scheduled for {displayDate(track.scheduledFor)} UTC.</p>}</section>}
    </div>
    <aside className="preview-column"><section className="panel preview"><div className="eyebrow">Canonical preview</div><h2>{title || "Untitled Track"}</h2><pre data-testid="canonical-preview">{JSON.stringify(canonicalPreview, null, 2)}</pre></section><section className="panel preview"><div className="eyebrow">Legacy preview</div><h2>Compatibility JSON</h2>{legacyPreview ? <pre data-testid="legacy-preview">{JSON.stringify(legacyPreview, null, 2)}</pre> : <p className="empty-inline">Not visible to legacy clients until published.</p>}</section></aside>
    <section className="panel history-panel"><h2>Revision history</h2>{track.revisions.length ? track.revisions.map((revision) => <div className="history-row" key={revision.id}><strong>r{revision.revisionNumber}</strong><span>{revision.title}</span><span>from v{revision.sourceWorkingVersion}</span><time>{displayDate(revision.createdAt)} UTC</time></div>) : <p className="muted">No frozen revisions yet.</p>}</section>
    <section className="panel history-panel"><h2>Audit trail</h2>{track.auditLogs.map((log) => <div className="history-row" key={log.id}><strong>{log.action}</strong><span>{log.actor?.name ?? "Scheduler"}</span><time>{displayDate(log.createdAt)} UTC</time></div>)}</section>
  </div>;
}
