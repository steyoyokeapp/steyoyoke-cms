"use client";
import "./cms-form-design.css";
import { CmsDatePicker } from "./cms-date-picker";
import "./release-form.css";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ReleaseEditorData, ReleaseTrackOption } from "./release-editor";
import type { ReleaseRelationshipOption } from "./release-create-form";
import type { ArtworkOption } from "./artwork-picker";
import { TrackArtistCombobox } from "./track-artist-combobox";
import { TrackMediaUpload } from "./track-media-upload";
import { ReleaseTracklist } from "./release-tracklist";
import { SecondarySections } from "./secondary-sections";
import { releaseStores, updateReleaseStores, type ReleaseStoreLinks } from "@/modules/releases/stores";
export function ReleaseForm({ release, artists, labels, tracks = [], mediaAssets = [], role = "EDITOR" }: { release?: ReleaseEditorData; artists: ReleaseRelationshipOption[]; labels: ReleaseRelationshipOption[]; tracks?: ReleaseTrackOption[]; mediaAssets?: ArtworkOption[]; role?: string }) {
  const router = useRouter(), dialog = useRef<HTMLDialogElement>(null); const canWrite = role !== "VIEWER", archived = release?.status === "ARCHIVED", disabled = !canWrite || archived;
  const [title, setTitle] = useState(release?.title ?? ""), [catalogue, setCatalogue] = useState(release?.catalogue ?? ""), [primary, setPrimary] = useState(release?.primaryArtistId ?? ""), [secondary, setSecondary] = useState(release?.secondaryArtistId ?? ""), [label, setLabel] = useState(release?.labelId ?? ""), [date, setDate] = useState(release?.releaseDate ?? "");
  const [links, setLinks] = useState<ReleaseStoreLinks>(() => Object.fromEntries(releaseStores.map(([key]) => [key, release?.[key] ?? ""])) as ReleaseStoreLinks); const manual = useRef(new Set<string>());
  const [artworkId, setArtworkId] = useState(release?.artworkAssetId ?? null), [selected, setSelected] = useState(() => (release?.trackIds ?? []).map(id => tracks.find(t => t.id === id)!).filter(Boolean));
  const [pending, setPending] = useState(false), [uploadBusy, setUploadBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(""), [scheduledFor, setScheduledFor] = useState(""); const busy = pending || uploadBusy;
  async function request(path: string, method: string, data: unknown) { const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); const result = await r.json(); if (!r.ok) throw Error(result.error?.message ?? "The operation failed."); return result; }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(""); if (!primary) return setError("Choose a Primary Artist from the search results."); setPending(true);
    const trackIds = selected.map(t => t.id), changed = !release || trackIds.length !== release.trackIds.length || trackIds.some((id, i) => release.trackIds[i] !== id);
    try { const result = await request(release ? `/api/admin/releases/${release.id}` : "/api/admin/releases", release ? "PATCH" : "POST", { title, catalogue, primaryArtistId: primary, secondaryArtistId: secondary, labelId: label, releaseDate: date, artworkAssetId: artworkId, ...links, soundcloudUrl: release?.soundcloudUrl ?? null, ...(changed ? { trackIds } : {}), ...(release ? { expectedWorkingVersion: release.workingVersion } : {}) }); if (release) window.location.reload(); else { router.push(`/admin/releases/${result.id}`); router.refresh(); } } catch (caught) { setError((caught as Error).message); setPending(false); }
  }
  async function perform(action: string, extra: Record<string, unknown> = {}) { if (!release) return; setPending(true); setError(""); try { await request(`/api/admin/releases/${release.id}/actions`, "POST", { action, ...extra }); if (action === "archive") { router.push("/admin/releases"); router.refresh(); } else window.location.reload(); } catch (caught) { setError((caught as Error).message); setPending(false); dialog.current?.close(); } }
  return <div className="catalogue-editor cms-form-design release-operational-form">
    {release && <p className="muted"><span className={`status ${release.status.toLowerCase()}`}>{release.status}</span>{release.publishedRevision && release.publishedRevision.sourceWorkingVersion !== release.workingVersion ? " · Unpublished changes" : ""}</p>}
    <form className="panel editor-form" onSubmit={save} onChange={() => setDirty(true)}>
      <section className="track-design-section"><div className="track-section-heading"><h2>Release details</h2><p>The Release information listeners will see.</p></div><div className="track-fields-grid">
        <label>Title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="Release title" maxLength={255} required readOnly={disabled || pending} /></label>
        <label>Catalogue<input value={catalogue} onChange={e => { const next = e.target.value; setLinks(current => updateReleaseStores(current, catalogue, next, manual.current)); setCatalogue(next); }} placeholder="SYYK303" maxLength={100} readOnly={disabled || pending} /></label>
        <label>Label<select value={label} onChange={e => setLabel(e.target.value)} required disabled={disabled || pending}><option value="" disabled>Choose Label</option>{labels.map(l => <option key={l.id} value={l.id}>{l.name}{l.active === false ? " (inactive · attached)" : ""}</option>)}</select></label>
        <TrackArtistCombobox modern label="Primary Artist" value={primary} initial={artists} onChange={value => { setPrimary(value); setDirty(true); }} required disabled={disabled || pending} />
        <TrackArtistCombobox modern label="Secondary Artist" value={secondary} initial={artists} onChange={value => { setSecondary(value); setDirty(true); }} disabled={disabled || pending} />
        <CmsDatePicker label="Release Date" value={date ?? ""} onChange={value => { setDate(value); setDirty(true); }} disabled={disabled || pending} />
      </div></section>
      <TrackMediaUpload modern kind="artwork" artworkAlt="Release artwork" initial={mediaAssets.find(a => a.id === release?.artworkAssetId)} disabled={disabled || pending} onBusy={setUploadBusy} onReady={asset => { setArtworkId(asset.id); setDirty(true); }} />
      <section className="track-design-section"><div className="track-section-heading"><h2>DSP links</h2><p>Catalogue fills default links. You can edit each destination.</p></div><div className="track-fields-grid">{releaseStores.map(([key, name]) => <label key={key}>{name}<input type="url" placeholder="https://syykrec.com/…" value={links[key]} onChange={e => { manual.current.add(key); setLinks(current => ({ ...current, [key]: e.target.value })); }} readOnly={disabled || pending} /></label>)}</div></section>
      <ReleaseTracklist value={selected} onChange={value => { setSelected(value); setDirty(true); }} disabled={disabled || pending} />
      {error && <p className="alert error" role="alert">{error}</p>}
      {!disabled && <div className="track-save-row"><button className="button primary" disabled={busy}>{pending ? "Saving…" : release ? "Save changes" : "Create release"}</button></div>}
    </form>
    {release && canWrite && !archived && <section className="track-design-section publish-panel"><div className="track-section-heading"><h2>Publication</h2><p>{dirty ? "Save your changes before publishing or scheduling." : "Publish the saved Release with its artwork and exact ordered Track versions."}</p></div><div className="button-row wrap">
      <button type="button" className="button" disabled={busy || dirty} onClick={() => perform("publish", { expectedWorkingVersion: release.workingVersion })}>Publish now</button>
      {release.status === "PUBLISHED" && <button type="button" className="button" disabled={busy} onClick={() => perform("unpublish")}>Unpublish</button>}
      {release.status === "SCHEDULED" ? <button type="button" className="button" disabled={busy} onClick={() => perform("cancelSchedule")}>Cancel schedule</button> : <><label>Schedule time<input type="datetime-local" value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} /></label><button type="button" className="button" disabled={busy || dirty || !scheduledFor} onClick={() => perform("schedule", { scheduledFor: new Date(scheduledFor).toISOString(), expectedWorkingVersion: release.workingVersion })}>Schedule</button></>}
    </div>{release.scheduledFor && <p className="muted">Scheduled for {new Date(release.scheduledFor).toLocaleString()}.</p>}</section>}
    {release && canWrite && <section className="track-danger-zone"><div><h2>Danger zone</h2><p>{archived ? "Restoring may make a previously published Release visible again." : "Archive this Release and remove it from public delivery. Artwork, Track membership and publication history are preserved."}</p></div><button type="button" className="button danger" disabled={busy} onClick={() => dialog.current?.showModal()}>{archived ? "Restore release" : "Delete release"}</button><dialog ref={dialog} aria-labelledby="release-danger-title"><h2 id="release-danger-title">{archived ? "Restore Release?" : "Delete / archive Release?"}</h2><p>{archived ? "A previously published Release may become publicly visible again." : "The Release will be archived. Historical versions and Tracks will not be deleted."}</p><div className="button-row"><button type="button" className="button" disabled={pending} onClick={() => dialog.current?.close()}>Cancel</button><button type="button" className="button danger" disabled={pending} onClick={() => perform(archived ? "restore" : "archive")}>{archived ? "Confirm restore" : "Confirm archive"}</button></div></dialog></section>}
    {release && <div className="release-form-secondary"><SecondarySections kind="releases" id={release.id} version={release.workingVersion} /></div>}
  </div>;
}
