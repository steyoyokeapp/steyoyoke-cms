"use client";

import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import { ArtworkPicker, type ArtworkOption } from "@/components/artwork-picker";

type Revision = { id: string; revisionNumber: number; sourceWorkingVersion: number; title: string; createdAt: string; trackCount: number };
type Audit = { id: string; action: string; createdAt: string; actor: { name: string } | null };
export type ReleaseTrackOption = { id: string; title: string; legacyId: number; status: string; primaryArtistName: string; labelName: string; publishedRevisionId: string | null; publishedRevisionNumber: number | null };
export type ReleaseArtistOption = { id: string; name: string; legacyId: number };
export type ReleaseLabelOption = { id: string; name: string; active?: boolean };
export type ReleaseEditorData = {
  id: string; legacyId: number; title: string; primaryArtistId: string; secondaryArtistId: string | null; labelId: string; releaseDate: string | null;
  spotifyUrl: string | null; beatportUrl: string | null; traxsourceUrl: string | null; bandcampUrl: string | null; appleMusicUrl: string | null; soundcloudUrl: string | null;
  artworkAssetId: string | null; status: string; workingVersion: number; scheduledFor: string | null; publishedRevision: Revision | null; scheduledRevision: Revision | null; revisions: Revision[]; auditLogs: Audit[];
  trackIds: string[];
};

async function result(response: Response) { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "The operation failed."); return body; }
const displayDate = (value: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));

export function ReleaseEditor({ release, role, artists, labels, tracks, mediaAssets, canonicalPreview, proposedLegacyPreview, publishedLegacyComplete }: { release: ReleaseEditorData; role: string; artists: ReleaseArtistOption[]; labels: ReleaseLabelOption[]; tracks: ReleaseTrackOption[]; mediaAssets: ArtworkOption[]; canonicalPreview: unknown; proposedLegacyPreview: unknown; publishedLegacyComplete: unknown }) {
  const canWrite = role !== "VIEWER"; const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [artistQuery, setArtistQuery] = useState(""); const [trackQuery, setTrackQuery] = useState("");
  const [title, setTitle] = useState(release.title); const [primaryArtistId, setPrimaryArtistId] = useState(release.primaryArtistId); const [secondaryArtistId, setSecondaryArtistId] = useState(release.secondaryArtistId ?? ""); const [labelId, setLabelId] = useState(release.labelId); const [releaseDate, setReleaseDate] = useState(release.releaseDate ?? ""); const [scheduledFor, setScheduledFor] = useState("");
  const [links, setLinks] = useState({ spotifyUrl: release.spotifyUrl ?? "", beatportUrl: release.beatportUrl ?? "", traxsourceUrl: release.traxsourceUrl ?? "", bandcampUrl: release.bandcampUrl ?? "", appleMusicUrl: release.appleMusicUrl ?? "", soundcloudUrl: release.soundcloudUrl ?? "" });
  const [artworkAssetId, setArtworkAssetId] = useState<string | null>(release.artworkAssetId);
  const [trackIds, setTrackIds] = useState(release.trackIds); const [pickerId, setPickerId] = useState(""); const [dragged, setDragged] = useState<number | null>(null);
  const shownArtists = useMemo(() => artists.filter((artist) => artist.name.toLowerCase().includes(artistQuery.toLowerCase()) || artist.id === primaryArtistId || artist.id === secondaryArtistId), [artists, artistQuery, primaryArtistId, secondaryArtistId]);
  const availableTracks = useMemo(() => tracks.filter((track) => !trackIds.includes(track.id) && (track.title.toLowerCase().includes(trackQuery.toLowerCase()) || track.primaryArtistName.toLowerCase().includes(trackQuery.toLowerCase()))), [tracks, trackIds, trackQuery]);
  const unpublishedChanges = !release.publishedRevision || release.publishedRevision.sourceWorkingVersion !== release.workingVersion;
  const selected = trackIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean) as ReleaseTrackOption[];

  function move(from: number, to: number) { if (to < 0 || to >= trackIds.length) return; const next = [...trackIds]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); setTrackIds(next); }
  function drop(event: DragEvent<HTMLDivElement>, to: number) { event.preventDefault(); if (dragged !== null) move(dragged, to); setDragged(null); }
  async function perform(action: string, extra: Record<string, unknown> = {}) {
    setPending(true); setError(""); try { await result(await fetch(`/api/admin/releases/${release.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) })); window.location.reload(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The operation failed."); setPending(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      await result(await fetch(`/api/admin/releases/${release.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, primaryArtistId, secondaryArtistId, labelId, releaseDate, artworkAssetId, ...links, expectedWorkingVersion: release.workingVersion }) }));
      const tracksChanged = trackIds.some((id, index) => release.trackIds[index] !== id) || trackIds.length !== release.trackIds.length;
      if (tracksChanged) {
        const sameMembership = trackIds.length === release.trackIds.length && trackIds.every((id) => release.trackIds.includes(id));
        await result(await fetch(`/api/admin/releases/${release.id}/tracks`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackIds, mode: sameMembership ? "reorder" : "replace", expectedWorkingVersion: release.workingVersion + 1 }) }));
      }
      window.location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save draft."); setPending(false); }
  }
  return <div className="editor-grid">
    <div className="editor-column">
      <section className="panel summary-strip"><span><small>Legacy ID</small><strong className="mono">{release.legacyId}</strong></span><span><small>Status</small><i className={`status ${release.status.toLowerCase()}`}>{release.status}</i></span><span><small>Working version</small><strong className="mono">v{release.workingVersion}</strong></span><span><small>Published revision</small><strong className="mono">{release.publishedRevision ? `r${release.publishedRevision.revisionNumber}` : "—"}</strong></span></section>
      {release.publishedRevision && <div className={`change-indicator ${unpublishedChanges ? "changed" : "synced"}`}>{unpublishedChanges ? "Unpublished changes" : "Draft matches published revision"}</div>}
      <form className="panel editor-form" onSubmit={save}>
        <div className="eyebrow">Core</div>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} readOnly={!canWrite} required /></label>
        <label>Search Artists<input value={artistQuery} onChange={(event) => setArtistQuery(event.target.value)} readOnly={!canWrite} placeholder="Filter picker" /></label>
        <label>Primary Artist<select value={primaryArtistId} onChange={(event) => setPrimaryArtistId(event.target.value)} disabled={!canWrite}>{shownArtists.map((artist) => <option key={artist.id} value={artist.id}>{artist.name} · #{artist.legacyId}</option>)}</select></label>
        <label>Secondary Artist<select value={secondaryArtistId} onChange={(event) => setSecondaryArtistId(event.target.value)} disabled={!canWrite}><option value="">None</option>{shownArtists.map((artist) => <option key={artist.id} value={artist.id}>{artist.name} · #{artist.legacyId}</option>)}</select></label>
        <label>Label<select value={labelId} onChange={(event) => setLabelId(event.target.value)} disabled={!canWrite}>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}{label.active === false ? " (inactive · attached)" : ""}</option>)}</select></label>
        <label>Release Date<input type="date" value={releaseDate} onChange={(event) => setReleaseDate(event.target.value)} readOnly={!canWrite} /></label>
        <div className="eyebrow section-break">Links</div>
        {([['spotifyUrl','Spotify'],['beatportUrl','Beatport'],['traxsourceUrl','Traxsource'],['bandcampUrl','Bandcamp'],['appleMusicUrl','Apple Music / iTunes'],['soundcloudUrl','SoundCloud']] as const).map(([key, name]) => <label key={key}>{name}<input type="url" value={links[key]} onChange={(event) => setLinks({ ...links, [key]: event.target.value })} readOnly={!canWrite} placeholder="https://" /></label>)}
        <div className="section-heading"><div><div className="eyebrow">Tracks</div><h2>Ordered membership</h2><p className="muted">Published Track revisions are frozen when this Release is published.</p></div></div>
        {canWrite && <div className="track-picker"><label>Search available Tracks<input value={trackQuery} onChange={(event) => setTrackQuery(event.target.value)} placeholder="Title or Artist" /></label><label>Available Track<select aria-label="Available Track" value={pickerId} onChange={(event) => setPickerId(event.target.value)}><option value="">Choose Track</option>{availableTracks.map((track) => <option key={track.id} value={track.id}>{track.title} · {track.primaryArtistName} · #{track.legacyId} · {track.status}{track.publishedRevisionId ? "" : " · unpublished"}</option>)}</select></label><button type="button" className="button" disabled={!pickerId} onClick={() => { setTrackIds([...trackIds, pickerId]); setPickerId(""); }}>Add Track</button></div>}
        <div className="release-track-list">{selected.length === 0 && <p className="empty-inline">No Tracks selected. At least one published Track is required before publishing.</p>}{selected.map((track, index) => {
          const current = (canonicalPreview as { tracks?: Array<{ id: string; changedSinceReleasePublication: boolean }> }).tracks?.find(({ id }) => id === track.id); const blocked = !track.publishedRevisionId || !["PUBLISHED", "SCHEDULED"].includes(track.status);
          return <div className="release-track-row" key={track.id} draggable={canWrite} onDragStart={() => setDragged(index)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, index)}><button type="button" className="drag-handle" aria-label={`Drag Track ${index + 1}`} disabled={!canWrite}>⋮⋮</button><strong className="mono">{index + 1}</strong><span><b>{track.title}</b><small>{track.primaryArtistName} · {track.labelName} · #{track.legacyId} · r{track.publishedRevisionNumber ?? "—"}</small>{blocked && <em className="blocking-warning">Blocks publication: {track.status.toLowerCase()}</em>}{current?.changedSinceReleasePublication && <em className="track-change-warning">Track has changed since this Release was last published.</em>}</span>{canWrite && <div className="release-track-actions"><button type="button" aria-label={`Move Track ${index + 1} up`} onClick={() => move(index, index - 1)} disabled={index === 0}>↑</button><button type="button" aria-label={`Move Track ${index + 1} down`} onClick={() => move(index, index + 1)} disabled={index === selected.length - 1}>↓</button><button type="button" aria-label={`Remove Track ${index + 1}`} onClick={() => setTrackIds(trackIds.filter((id) => id !== track.id))}>Remove</button></div>}</div>;
        })}</div>
        {error && <div className="alert error" role="alert">{error}</div>}{canWrite && release.status !== "ARCHIVED" && <div className="button-row"><button className="button primary" disabled={pending}>Save Draft</button></div>}
      </form>
      <ArtworkPicker value={artworkAssetId} assets={mediaAssets} canWrite={canWrite && release.status !== "ARCHIVED"} requiredForPublish onChange={setArtworkAssetId} />
      {canWrite && <section className="panel publish-panel"><h2>Publication</h2><p className="muted">Publishing freezes Release metadata, Artist and Label delivery values, exact Track revisions, and Track order.</p><div className="button-row wrap">
        {release.status !== "ARCHIVED" && <button className="button" disabled={pending} onClick={() => perform("publish", { expectedWorkingVersion: release.workingVersion })}>Publish now</button>}
        {release.status === "PUBLISHED" && <button className="button" disabled={pending} onClick={() => perform("unpublish")}>Unpublish</button>}
        {release.status !== "ARCHIVED" && release.status !== "SCHEDULED" && <><input aria-label="Schedule time" type="datetime-local" value={scheduledFor} onInput={(event) => setScheduledFor(event.currentTarget.value)} /><button className="button" disabled={pending || !scheduledFor} onClick={() => perform("schedule", { scheduledFor: new Date(scheduledFor).toISOString(), expectedWorkingVersion: release.workingVersion })}>Schedule</button></>}
        {release.status === "SCHEDULED" && <button className="button" disabled={pending} onClick={() => perform("cancelSchedule")}>Cancel schedule</button>}
        {release.status === "ARCHIVED" ? <button className="button" disabled={pending} onClick={() => perform("restore")}>Restore</button> : <button className="button danger" disabled={pending} onClick={() => perform("archive")}>Archive</button>}
      </div>{release.scheduledFor && <p className="schedule-note">Scheduled for {displayDate(release.scheduledFor)} UTC.</p>}</section>}
    </div>
    <aside className="preview-column"><section className="panel preview"><div className="eyebrow">Canonical preview</div><h2>{title || "Untitled Release"}</h2><pre data-testid="canonical-preview">{JSON.stringify(canonicalPreview, null, 2)}</pre></section><section className="panel preview"><div className="eyebrow">Legacy Release preview</div><h2>Proposed compatibility JSON</h2><pre data-testid="legacy-release-preview">{JSON.stringify(proposedLegacyPreview, null, 2)}</pre></section><section className="panel preview"><div className="eyebrow">Published releasecomplete</div>{publishedLegacyComplete ? <pre data-testid="releasecomplete-preview">{JSON.stringify(publishedLegacyComplete, null, 2)}</pre> : <p className="empty-inline">Not visible to legacy clients until published.</p>}</section></aside>
    <section className="panel history-panel"><h2>Revision history</h2>{release.revisions.length ? release.revisions.map((revision) => <div className="history-row" key={revision.id}><strong>r{revision.revisionNumber}</strong><span>{revision.title} · {revision.trackCount} Tracks</span><span>from v{revision.sourceWorkingVersion}</span><time>{displayDate(revision.createdAt)} UTC</time></div>) : <p className="muted">No frozen revisions yet.</p>}</section>
    <section className="panel history-panel"><h2>Audit trail</h2>{release.auditLogs.map((log) => <div className="history-row" key={log.id}><strong>{log.action}</strong><span>{log.actor?.name ?? "Scheduler"}</span><time>{displayDate(log.createdAt)} UTC</time></div>)}</section>
  </div>;
}
