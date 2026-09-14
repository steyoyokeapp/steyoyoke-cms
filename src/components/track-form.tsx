"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { TrackEditorData } from "./track-editor";
import type { TrackOption } from "./track-create-form";
import type { AudioOption } from "./audio-picker";
import type { ArtworkOption } from "./artwork-picker";
import { TrackArtistCombobox } from "./track-artist-combobox";
import { TrackMediaUpload } from "./track-media-upload";
import { defaultTrackStores, trackStores, trackAudioFilename } from "@/modules/media/track-audio-contract";
export function TrackForm({ track, artists, labels, role, mediaAssets = [], audioAssets = [] }: { track?: TrackEditorData; artists: TrackOption[]; labels: TrackOption[]; role: string; mediaAssets?: ArtworkOption[]; audioAssets?: AudioOption[] }) {
  const router = useRouter(); const dialog = useRef<HTMLDialogElement>(null);
  const disabled = role === "VIEWER" || track?.status === "ARCHIVED";
  const [title, setTitle] = useState(track?.title ?? ""); const [primary, setPrimary] = useState(track?.primaryArtistId ?? "");
  const [secondary, setSecondary] = useState(track?.secondaryArtistId ?? ""); const [label, setLabel] = useState(track?.labelId ?? "");
  const [audioId, setAudioId] = useState(track?.audioAssetId ?? null); const [artworkId, setArtworkId] = useState(track?.artworkAssetId ?? null);
  const [links, setLinks] = useState<Record<string, string>>(Object.fromEntries(trackStores.map(([key]) => [key, track?.[key] ?? ""])));
  const touched = useRef(new Set<string>()); const [catalogueMessage, setCatalogueMessage] = useState("");
  const [pending, setPending] = useState(false); const [audioBusy, setAudioBusy] = useState(false); const [artworkBusy, setArtworkBusy] = useState(false); const [error, setError] = useState("");
  const busy = pending || audioBusy || artworkBusy;
  async function request(url: string, payload: unknown, method: string) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? "The operation failed."); return result;
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!primary) return setError("Choose a Primary Artist from the search results.");
    setPending(true);
    try {
      const result = await request(track ? `/api/admin/tracks/${track.id}` : "/api/admin/tracks", { title, primaryArtistId: primary, secondaryArtistId: secondary, labelId: label, audioAssetId: audioId, artworkAssetId: artworkId, ...links, ...(track ? { expectedWorkingVersion: track.workingVersion } : {}) }, track ? "PATCH" : "POST");
      if (track) window.location.reload(); else { router.push(`/admin/tracks/${result.id}`); router.refresh(); }
    } catch (caught) { setError((caught as Error).message); setPending(false); }
  }
  async function remove() {
    if (!track) return; setPending(true); setError("");
    try { await request(`/api/admin/tracks/${track.id}/actions`, { action: "archive" }, "POST"); router.push("/admin/tracks"); router.refresh(); }
    catch (caught) { setError((caught as Error).message); dialog.current?.close(); setPending(false); }
  }
  return <div className="catalogue-editor">
    <form className="panel editor-form" onSubmit={save}>
      <TrackMediaUpload kind="audio" initial={audioAssets.map(a => ({ ...a, durationMs: a.durationMs ?? track?.durationMs ?? null })).find(a => a.id === track?.audioAssetId)} disabled={disabled || pending} onBusy={setAudioBusy} onReady={asset => {
        setAudioId(asset.id);
        if (asset.originalFilename) {
          const defaults = defaultTrackStores(asset.originalFilename);
          setLinks(current => Object.fromEntries(trackStores.map(([key]) => [key, !current[key] && !touched.current.has(key) ? defaults[key] ?? "" : current[key] ?? ""])));
          setCatalogueMessage(trackAudioFilename(asset.originalFilename).catalogue ? "" : "Catalogue could not be identified. Enter store links manually.");
        }
      }} />
      <label>Title<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={255} readOnly={disabled} /></label>
      <TrackArtistCombobox label="Primary Artist" value={primary} initial={artists} onChange={setPrimary} required disabled={disabled} />
      <TrackArtistCombobox label="Secondary Artist" value={secondary} initial={artists} onChange={setSecondary} disabled={disabled} />
      <label htmlFor="track-label">Label</label><select id="track-label" value={label} onChange={e => setLabel(e.target.value)} required disabled={disabled}><option value="" disabled>Choose Label</option>{labels.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <TrackMediaUpload kind="artwork" initial={mediaAssets.find(a => a.id === track?.artworkAssetId)} disabled={disabled || pending} onBusy={setArtworkBusy} onReady={asset => setArtworkId(asset.id)} />
      <h2>Store links</h2>{catalogueMessage && <p className="muted">{catalogueMessage}</p>}
      {trackStores.map(([key, name]) => <label key={key}>{name}<input type="url" value={links[key]} readOnly={disabled} placeholder="https://" onChange={e => { touched.current.add(key); setLinks({ ...links, [key]: e.target.value }); }} /></label>)}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!disabled && <button className="button primary" disabled={busy}>{pending ? "Saving…" : track ? "Save changes" : "Create track"}</button>}
    </form>
    {track && !disabled && <section className="panel" style={{ marginTop: 24 }}><h2>Danger zone</h2><button type="button" className="button danger" disabled={busy} onClick={() => dialog.current?.showModal()}>Delete track</button>
      <dialog ref={dialog} aria-labelledby="delete-track-title"><h2 id="delete-track-title">Delete track?</h2><p>This removes the Track from the active catalogue workflow. Historical releases and audio will be preserved.</p><div className="button-row"><button className="button" disabled={pending} onClick={() => dialog.current?.close()}>Cancel</button><button className="button danger" disabled={pending} onClick={remove}>Confirm delete</button></div></dialog>
    </section>}
    {track?.status === "ARCHIVED" && <p>This Track has been deleted from the active workflow.</p>}
  </div>;
}
