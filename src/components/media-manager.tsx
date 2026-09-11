"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { formatCmsDate } from "@/lib/date";
import { formatAudioDuration } from "@/modules/media/format";

type LibraryView = "ACTIVE" | "RETIRED";
type KindFilter = "ALL" | "IMAGE" | "AUDIO";
type MediaReference = { type: string; id: string; name?: string; title?: string; artistId?: string; trackId?: string; episodeId?: string; releaseId?: string; revisionNumber?: number };
type MediaRow = {
  id: string; kind: "IMAGE" | "AUDIO"; originalFilename: string | null; compatibilityFilename: string | null; legacyAudioId: string | null;
  width: number | null; height: number | null; durationMs: number | null; status: string; mimeType: string | null; byteSize: number | null;
  sha256Checksum: string | null; sourceStorageKey: string | null; failureReason?: string | null; referenceCount: number; references: MediaReference[];
  createdAt: string; retiredAt?: string | null; createdBy: { name: string }; processingJob?: { status: string } | null;
  variants: Array<{ variantKey: string; width: number; height: number; byteSize: number; sha256Checksum: string; storageKey: string }>;
};
type OptimisticUpload = { id: string; kind: "IMAGE"; originalFilename: string; byteSize: number; previewUrl: string };

const normalize = (asset: MediaRow) => ({ ...asset, referenceCount: asset.referenceCount ?? 0, references: asset.references ?? [], variants: asset.variants ?? [] });
const previewUrl = (asset: MediaRow, thumbnail = false) => asset.status === "READY" && asset.compatibilityFilename
  ? `/assets/uploads/files/${thumbnail ? "thumbnails/256/" : ""}${asset.compatibilityFilename}`
  : asset.sourceStorageKey ? `/api/admin/media/${asset.id}/source` : null;

export function MediaManager({ initial, role, initialView = "ACTIVE", initialFilter = "ALL" }: { initial: MediaRow[]; role: string; initialView?: LibraryView; initialFilter?: KindFilter }) {
  const [assets, setAssets] = useState(initial.map(normalize));
  const [view, setView] = useState<LibraryView>(initialView);
  const [filter, setFilter] = useState<KindFilter>(initialFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<OptimisticUpload[]>([]);
  const [pendingAction, setPendingAction] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const optimisticUrls = useRef(new Map<string, string>());
  const canUpload = role !== "VIEWER";
  const activeCount = assets.filter(({ status }) => status !== "RETIRED").length + optimistic.length;
  const retiredCount = assets.filter(({ status }) => status === "RETIRED").length;
  const visibleAssets = useMemo(() => assets.filter((asset) => (view === "RETIRED" ? asset.status === "RETIRED" : asset.status !== "RETIRED") && (filter === "ALL" || asset.kind === filter)), [assets, filter, view]);
  const selected = visibleAssets.find(({ id }) => id === selectedId) ?? visibleAssets[0] ?? null;
  const visibleOptimistic = view === "ACTIVE" && filter !== "AUDIO" ? optimistic : [];
  const hasProcessing = assets.some((asset) => asset.status === "PROCESSING");

  useEffect(() => {
    const onPopState = () => {
      const query = new URLSearchParams(window.location.search);
      setView(query.get("view") === "retired" ? "RETIRED" : "ACTIVE");
      const kind = query.get("kind");
      setFilter(kind === "IMAGE" || kind === "AUDIO" ? kind : "ALL");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => () => {
    for (const url of optimisticUrls.current.values()) URL.revokeObjectURL(url);
    optimisticUrls.current.clear();
  }, []);

  useEffect(() => {
    if (!hasProcessing) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/admin/media", { cache: "no-store" });
        if (!response.ok || !active) return;
        const next = (await response.json() as MediaRow[]).map(normalize);
        setAssets(next);
      } catch { /* A later poll will retry while processing rows remain. */ }
    };
    const timer = window.setInterval(refresh, 1_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [hasProcessing]);

  function changeBrowseState(nextView: LibraryView, nextFilter: KindFilter) {
    setView(nextView); setFilter(nextFilter); setConfirmDelete(false);
    const url = new URL(window.location.href);
    if (nextView === "RETIRED") url.searchParams.set("view", "retired"); else url.searchParams.delete("view");
    if (nextFilter === "ALL") url.searchParams.delete("kind"); else url.searchParams.set("kind", nextFilter);
    window.history.pushState(null, "", url);
  }

  function releaseOptimistic(id: string) {
    const url = optimisticUrls.current.get(id);
    if (url) URL.revokeObjectURL(url);
    optimisticUrls.current.delete(id);
    setOptimistic((current) => current.filter((item) => item.id !== id));
  }

  async function onUpload(event: ChangeEvent<HTMLInputElement>, kind: "IMAGE" | "AUDIO") {
    const file = event.target.files?.[0]; if (!file) return;
    const temporaryId = kind === "IMAGE" ? `optimistic:${crypto.randomUUID()}` : null;
    if (temporaryId) {
      const localPreview = URL.createObjectURL(file);
      optimisticUrls.current.set(temporaryId, localPreview);
      setOptimistic((current) => [{ id: temporaryId, kind: "IMAGE", originalFilename: file.name, byteSize: file.size, previewUrl: localPreview }, ...current]);
    }
    const uploadFilter = filter === "ALL" || filter === kind ? filter : "ALL";
    if (view !== "ACTIVE" || uploadFilter !== filter) changeBrowseState("ACTIVE", uploadFilter);
    const data = new FormData(); data.set("kind", kind); data.set("file", file);
    setUploadingCount((count) => count + 1); setError("");
    try {
      const response = await fetch("/api/admin/media", { method: "POST", body: data });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Upload failed.");
      const asset = normalize(body as MediaRow);
      setAssets((current) => [asset, ...current.filter(({ id }) => id !== asset.id)]);
      setSelectedId(asset.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      if (temporaryId) releaseOptimistic(temporaryId);
      setUploadingCount((count) => Math.max(0, count - 1));
      event.target.value = "";
    }
  }

  async function retryProcessing() {
    if (!selected) return; setPendingAction(true); setError("");
    try {
      const response = await fetch(`/api/admin/media/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retryProcessing" }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Retry failed.");
      const asset = normalize(body as MediaRow); setAssets((current) => current.map((value) => value.id === asset.id ? asset : value)); setSelectedId(asset.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Retry failed."); }
    finally { setPendingAction(false); }
  }

  async function retire() {
    if (!selected) return; setPendingAction(true); setError("");
    try {
      const response = await fetch(`/api/admin/media/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retire" }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Retire failed.");
      setAssets((current) => current.map((asset) => asset.id === selected.id ? { ...asset, status: "RETIRED", retiredAt: body.retiredAt ?? new Date().toISOString() } : asset));
      setSelectedId(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Retire failed."); }
    finally { setPendingAction(false); }
  }

  async function deletePermanently() {
    if (!selected) return; setPendingAction(true); setError("");
    try {
      const response = await fetch(`/api/admin/media/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deletePermanently" }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Permanent deletion failed.");
      setAssets((current) => current.filter(({ id }) => id !== selected.id)); setSelectedId(null); setConfirmDelete(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Permanent deletion failed."); setConfirmDelete(false); }
    finally { setPendingAction(false); }
  }

  const deleteBlocked = Boolean(selected && (selected.referenceCount > 0 || selected.processingJob?.status === "RUNNING"));
  return <>
    <section className="panel media-toolbar">
      <div className="media-toolbar-heading"><div className="eyebrow">Library</div><h2>Media assets</h2></div>
      <div className="media-toolbar-actions">
        <div className="media-tabs" role="tablist" aria-label="Media lifecycle"><button type="button" role="tab" aria-selected={view === "ACTIVE"} onClick={() => changeBrowseState("ACTIVE", filter)}>Active <span>{activeCount}</span></button><button type="button" role="tab" aria-selected={view === "RETIRED"} onClick={() => changeBrowseState("RETIRED", filter)}>Retired <span>{retiredCount}</span></button></div>
        <select className="media-kind-filter" aria-label="Kind filter" value={filter} onChange={(event) => changeBrowseState(view, event.target.value as KindFilter)}><option value="ALL">All</option><option value="IMAGE">Images</option><option value="AUDIO">Audio</option></select>
        {canUpload && <div className="button-row"><label className="button primary">{uploadingCount ? "Uploading…" : "Upload image"}<input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => onUpload(event, "IMAGE")} /></label><label className="button">Upload MP3<input hidden type="file" accept="audio/mpeg,.mp3" onChange={(event) => onUpload(event, "AUDIO")} /></label></div>}
      </div>
    </section>
    {error && <div className="alert error" role="alert">{error}</div>}
    <section className="panel table-panel media-library-panel">
      {!visibleOptimistic.length && !visibleAssets.length ? <div className="empty media-empty"><strong>{view === "RETIRED" ? "No retired media assets." : "No active media assets yet."}</strong><span>{view === "RETIRED" ? "Retired assets remain available here until permanently deleted." : "Upload an image or MP3 to create the first asset."}</span></div> : <div className="media-grid">
        {visibleOptimistic.map((item) => <div className="media-card optimistic" data-optimistic="true" aria-disabled="true" key={item.id}>{/* eslint-disable-next-line @next/next/no-img-element -- Blob URLs are temporary local previews and cannot use the Next image optimizer. */}<img src={item.previewUrl} alt=""/><strong>{item.originalFilename}</strong><small>{(item.byteSize / 1024).toFixed(1)} KB · Local preview</small><i className="status uploading">UPLOADING</i><small>Sending source…</small></div>)}
        {visibleAssets.map((asset) => <button type="button" className={`media-card${selected?.id === asset.id ? " selected" : ""}`} aria-pressed={selected?.id === asset.id} key={asset.id} onClick={() => setSelectedId(asset.id)}>{asset.kind === "IMAGE" && previewUrl(asset, true) ? <img src={previewUrl(asset, true)!} alt="" /> : <span className="audio-tile" aria-hidden="true">{asset.kind === "AUDIO" ? "♫" : "◇"}</span>}<strong>{asset.originalFilename ?? asset.legacyAudioId ?? "External audio"}</strong><small>{asset.kind === "IMAGE" ? `${asset.width}×${asset.height}` : formatAudioDuration(asset.durationMs)} · {asset.byteSize === null ? "external" : `${(asset.byteSize / 1024).toFixed(1)} KB`}</small><i className={`status ${asset.status.toLowerCase()}`}>{asset.status}</i><small>{asset.status === "PROCESSING" ? "Creating representations…" : `${asset.referenceCount} references`} · {formatCmsDate(asset.retiredAt ?? asset.createdAt)} · {asset.createdBy.name}</small></button>)}
      </div>}
    </section>
    {selected && <section className="panel preview media-detail">
      <div className="media-detail-heading"><div><div className="eyebrow">{selected.kind} detail</div><h2>Asset details</h2></div><i className={`status ${selected.status.toLowerCase()}`}>{selected.status}</i></div>
      <div className="media-detail-grid">
        <div className="media-detail-preview">{selected.kind === "IMAGE" && previewUrl(selected) ? <img className="detail-artwork" src={previewUrl(selected)!} alt={selected.originalFilename ?? "Artwork"} /> : selected.kind === "AUDIO" && selected.sourceStorageKey ? <audio controls preload="metadata" src={selected.status === "READY" && selected.legacyAudioId ? `/legacy-audio/${selected.legacyAudioId}-high.mp3` : `/api/admin/media/${selected.id}/source`} /> : <div className="empty-inline">No stored preview is available.</div>}</div>
        <div className="media-detail-data"><dl><dt>MediaAsset ID</dt><dd className="mono">{selected.id}</dd><dt>Kind</dt><dd>{selected.kind}</dd><dt>Status</dt><dd>{selected.status}</dd>{selected.status === "FAILED" && <><dt>Failure</dt><dd>{selected.failureReason ?? "Representation processing failed."}</dd></>}<dt>MIME</dt><dd>{selected.mimeType ?? "External"}</dd>{selected.kind === "IMAGE" ? <><dt>Dimensions</dt><dd>{selected.width}×{selected.height}</dd><dt>Compatibility filename</dt><dd className="mono">{selected.compatibilityFilename}</dd></> : <><dt>Duration</dt><dd>{formatAudioDuration(selected.durationMs)}</dd><dt>Compatibility audio ID</dt><dd className="mono">{selected.legacyAudioId}</dd></>}<dt>Size</dt><dd>{selected.byteSize === null ? "External" : `${(selected.byteSize / 1024).toFixed(1)} KB`}</dd><dt>Creator</dt><dd>{selected.createdBy.name}</dd><dt>Created</dt><dd>{formatCmsDate(selected.createdAt)}</dd>{selected.retiredAt && <><dt>Retired</dt><dd>{formatCmsDate(selected.retiredAt)}</dd></>}<dt>Checksum</dt><dd className="mono">{selected.sha256Checksum ?? "Not materialized"}</dd><dt>Storage key</dt><dd className="mono">{selected.sourceStorageKey ?? "External legacy reference"}</dd><dt>References</dt><dd>{selected.referenceCount}</dd></dl></div>
      </div>
      {selected.references.length > 0 && <div className="media-detail-section"><h3>Blocking references</h3><ul>{selected.references.map((reference) => <li key={`${reference.type}-${reference.id}`}><strong>{reference.type}</strong> — {reference.name ?? reference.title ?? `revision ${reference.revisionNumber}`}</li>)}</ul></div>}
      {selected.kind === "IMAGE" && selected.variants.length > 0 && <div className="media-detail-section"><h3>Variants</h3><div className="media-variant-grid">{selected.variants.map((variant) => <p key={variant.variantKey}><strong>{variant.variantKey}</strong><br/><span className="mono">{variant.storageKey}</span><br/>{variant.width}×{variant.height} · {variant.byteSize} bytes<br/><span className="mono">{variant.sha256Checksum}</span></p>)}</div></div>}
      {selected.status === "FAILED" && canUpload && <div className="media-detail-actions"><button className="button primary" onClick={retryProcessing} disabled={pendingAction}>{pendingAction ? "Retrying…" : "Retry processing"}</button></div>}
      {role === "ADMIN" && selected.referenceCount === 0 && !["RETIRED", "PROCESSING"].includes(selected.status) && <div className="media-detail-actions"><button className="button danger" onClick={retire} disabled={pendingAction}>Retire</button></div>}
      {role === "ADMIN" && selected.status === "RETIRED" && <div className="media-detail-actions permanent-delete-actions"><div>{deleteBlocked && <small>Permanent deletion is blocked by {selected.referenceCount ? `${selected.referenceCount} content reference${selected.referenceCount === 1 ? "" : "s"}` : "a running processing job"}.</small>}</div><button className="button danger" onClick={() => setConfirmDelete(true)} disabled={pendingAction || deleteBlocked}>Delete permanently</button></div>}
    </section>}
    {confirmDelete && selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmDelete(false); }}><section className="panel confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="delete-media-title"><div className="eyebrow">Destructive action</div><h2 id="delete-media-title">Delete permanently?</h2><p>This permanently removes:</p><ul><li>the uploaded source</li><li>all generated variants</li><li>the database media record</li></ul><p><strong>This cannot be undone.</strong></p><div className="button-row"><button className="button" onClick={() => setConfirmDelete(false)} disabled={pendingAction}>Cancel</button><button className="button danger" onClick={deletePermanently} disabled={pendingAction}>{pendingAction ? "Deleting…" : "DELETE PERMANENTLY"}</button></div></section></div>}
  </>;
}
