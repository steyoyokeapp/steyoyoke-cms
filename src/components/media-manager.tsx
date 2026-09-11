"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { formatCmsDate } from "@/lib/date";
import { formatAudioDuration } from "@/modules/media/format";

type MediaReference = { type: string; id: string; name?: string; title?: string; artistId?: string; trackId?: string; episodeId?: string; releaseId?: string; revisionNumber?: number };
type MediaRow = { id: string; kind: "IMAGE" | "AUDIO"; originalFilename: string | null; compatibilityFilename: string | null; legacyAudioId: string | null; width: number | null; height: number | null; durationMs: number | null; status: string; mimeType: string | null; byteSize: number | null; sha256Checksum: string | null; sourceStorageKey: string | null; failureReason?: string | null; referenceCount: number; references: MediaReference[]; createdAt: string; createdBy: { name: string }; variants: Array<{ variantKey: string; width: number; height: number; byteSize: number; sha256Checksum: string; storageKey: string }> };

const normalize = (asset: MediaRow) => ({ ...asset, referenceCount: asset.referenceCount ?? 0, references: asset.references ?? [], variants: asset.variants ?? [] });
const previewUrl = (asset: MediaRow, thumbnail = false) => asset.status === "READY" && asset.compatibilityFilename
  ? `/assets/uploads/files/${thumbnail ? "thumbnails/256/" : ""}${asset.compatibilityFilename}`
  : `/api/admin/media/${asset.id}/source`;

export function MediaManager({ initial, role }: { initial: MediaRow[]; role: string }) {
  const [assets, setAssets] = useState(initial); const [selected, setSelected] = useState<MediaRow | null>(initial[0] ?? null); const [filter, setFilter] = useState<"ALL" | "IMAGE" | "AUDIO">("ALL"); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const canUpload = role !== "VIEWER"; const shown = filter === "ALL" ? assets : assets.filter((asset) => asset.kind === filter);
  const hasProcessing = assets.some((asset) => asset.status === "PROCESSING");
  useEffect(() => {
    if (!hasProcessing) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/admin/media", { cache: "no-store" });
        if (!response.ok || !active) return;
        const next = (await response.json() as MediaRow[]).map(normalize);
        setAssets(next); setSelected((current) => current ? next.find(({ id }) => id === current.id) ?? current : next[0] ?? null);
      } catch { /* A later poll will retry while processing rows remain. */ }
    };
    const timer = window.setInterval(refresh, 1_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [hasProcessing]);
  async function onUpload(event: ChangeEvent<HTMLInputElement>, kind: "IMAGE" | "AUDIO") { const file = event.target.files?.[0]; if (!file) return; const data = new FormData(); data.set("kind", kind); data.set("file", file); setPending(true); setError(""); try { const response = await fetch("/api/admin/media", { method: "POST", body: data }); const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Upload failed."); const asset = normalize(body as MediaRow); setAssets((current) => [asset, ...current.filter(({ id }) => id !== asset.id)]); setSelected(asset); } catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed."); } finally { setPending(false); event.target.value = ""; } }
  async function retryProcessing() { if (!selected) return; setPending(true); setError(""); try { const response = await fetch(`/api/admin/media/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retryProcessing" }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Retry failed."); const asset = normalize(body as MediaRow); setAssets((current) => current.map((value) => value.id === asset.id ? asset : value)); setSelected(asset); } catch (caught) { setError(caught instanceof Error ? caught.message : "Retry failed."); } finally { setPending(false); } }
  async function retire() { if (!selected) return; setPending(true); const response = await fetch(`/api/admin/media/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retire" }) }); const body = await response.json(); if (!response.ok) { setError(body.error?.message ?? "Retire failed."); setPending(false); return; } setAssets(assets.map((asset) => asset.id === selected.id ? { ...asset, status: "RETIRED" } : asset)); setSelected({ ...selected, status: "RETIRED" }); setPending(false); }
  return <>
    <section className="panel media-toolbar">
      <div className="media-toolbar-heading"><div className="eyebrow">Library</div><h2>Media assets</h2></div>
      <div className="media-toolbar-actions">
        <select className="media-kind-filter" aria-label="Kind filter" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="ALL">All</option><option value="IMAGE">Images</option><option value="AUDIO">Audio</option></select>
        {canUpload && <div className="button-row"><label className="button primary">{pending ? "Processing…" : "Upload image"}<input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => onUpload(event, "IMAGE")} disabled={pending} /></label><label className="button">{pending ? "Processing…" : "Upload MP3"}<input hidden type="file" accept="audio/mpeg,.mp3" onChange={(event) => onUpload(event, "AUDIO")} disabled={pending} /></label></div>}
      </div>
    </section>
    {error && <div className="alert error" role="alert">{error}</div>}
    <section className="panel table-panel media-library-panel">
      {shown.length === 0 ? <div className="empty media-empty"><strong>{assets.length === 0 ? "No media assets yet." : "No media assets match this filter."}</strong><span>{assets.length === 0 ? "Upload an image or MP3 to create the first asset." : "Choose another kind to view available assets."}</span></div> : <div className="media-grid">{shown.map((asset) => <button type="button" className={`media-card${selected?.id === asset.id ? " selected" : ""}`} aria-pressed={selected?.id === asset.id} key={asset.id} onClick={() => setSelected(asset)}>{asset.kind === "IMAGE" ? <img src={previewUrl(asset, true)} alt="" /> : <span className="audio-tile" aria-hidden="true">♫</span>}<strong>{asset.originalFilename ?? asset.legacyAudioId ?? "External audio"}</strong><small>{asset.kind === "IMAGE" ? `${asset.width}×${asset.height}` : formatAudioDuration(asset.durationMs)} · {asset.byteSize === null ? "external" : `${(asset.byteSize / 1024).toFixed(1)} KB`}</small><i className={`status ${asset.status.toLowerCase()}`}>{asset.status}</i><small>{asset.status === "PROCESSING" ? "Creating representations…" : `${asset.referenceCount} references`} · {formatCmsDate(asset.createdAt)} · {asset.createdBy.name}</small></button>)}</div>}
    </section>
    {selected && <section className="panel preview media-detail">
      <div className="media-detail-heading"><div><div className="eyebrow">{selected.kind} detail</div><h2>Asset details</h2></div><i className={`status ${selected.status.toLowerCase()}`}>{selected.status}</i></div>
      <div className="media-detail-grid">
        <div className="media-detail-preview">{selected.kind === "IMAGE" ? <img className="detail-artwork" src={previewUrl(selected)} alt={selected.originalFilename ?? "Artwork"} /> : selected.status === "READY" && selected.legacyAudioId && <audio controls preload="metadata" src={`/legacy-audio/${selected.legacyAudioId}-high.mp3`} />}</div>
        <div className="media-detail-data"><dl><dt>MediaAsset ID</dt><dd className="mono">{selected.id}</dd><dt>Kind</dt><dd>{selected.kind}</dd><dt>Status</dt><dd>{selected.status}</dd>{selected.status === "FAILED" && <><dt>Failure</dt><dd>{selected.failureReason ?? "Representation processing failed."}</dd></>}<dt>MIME</dt><dd>{selected.mimeType ?? "External"}</dd>{selected.kind === "IMAGE" ? <><dt>Dimensions</dt><dd>{selected.width}×{selected.height}</dd><dt>Compatibility filename</dt><dd className="mono">{selected.compatibilityFilename}</dd></> : <><dt>Duration</dt><dd>{formatAudioDuration(selected.durationMs)}</dd><dt>Compatibility audio ID</dt><dd className="mono">{selected.legacyAudioId}</dd></>}<dt>Size</dt><dd>{selected.byteSize === null ? "External" : `${(selected.byteSize / 1024).toFixed(1)} KB`}</dd><dt>Creator</dt><dd>{selected.createdBy.name}</dd><dt>Created</dt><dd>{formatCmsDate(selected.createdAt)}</dd><dt>Checksum</dt><dd className="mono">{selected.sha256Checksum ?? "Not materialized"}</dd><dt>Storage key</dt><dd className="mono">{selected.sourceStorageKey ?? "External legacy reference"}</dd><dt>References</dt><dd>{selected.referenceCount}</dd></dl></div>
      </div>
      {selected.references.length > 0 && <div className="media-detail-section"><h3>References</h3><ul>{selected.references.map((reference) => <li key={`${reference.type}-${reference.id}`}><strong>{reference.type}</strong> — {reference.name ?? reference.title ?? `revision ${reference.revisionNumber}`}</li>)}</ul></div>}
      {selected.kind === "IMAGE" && selected.variants.length > 0 && <div className="media-detail-section"><h3>Variants</h3><div className="media-variant-grid">{selected.variants.map((variant) => <p key={variant.variantKey}><strong>{variant.variantKey}</strong><br/><span className="mono">{variant.storageKey}</span><br/>{variant.width}×{variant.height} · {variant.byteSize} bytes<br/><span className="mono">{variant.sha256Checksum}</span></p>)}</div></div>}
      {selected.status === "FAILED" && canUpload && <div className="media-detail-actions"><button className="button primary" onClick={retryProcessing} disabled={pending}>{pending ? "Retrying…" : "Retry processing"}</button></div>}
      {role === "ADMIN" && selected.referenceCount === 0 && !["RETIRED", "PROCESSING"].includes(selected.status) && <div className="media-detail-actions"><button className="button danger" onClick={retire} disabled={pending}>Retire</button></div>}
    </section>}
  </>;
}
