"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { formatCmsDate } from "@/lib/date";
import { formatAudioDuration } from "@/modules/media/format";

import { mediaBrowseQuery, parseMediaBrowse, type MediaBrowseState } from "@/modules/media/browse";

type LibraryView = "ACTIVE" | "RETIRED";
type KindFilter = "ALL" | "IMAGE" | "AUDIO";
type MediaReference = { type: string; id: string; name?: string; title?: string; artistId?: string; trackId?: string; episodeId?: string; releaseId?: string; revisionNumber?: number };
type MediaRow = {
  id: string; kind: "IMAGE" | "AUDIO"; originalFilename: string | null; compatibilityFilename: string | null; legacyAudioId: string | null;
  width: number | null; height: number | null; durationMs: number | null; status: string; mimeType: string | null; byteSize: number | null;
  sha256Checksum: string | null; sourceStorageKey: string | null; failureReason?: string | null; referenceCount: number; references: MediaReference[];
  createdAt: string; updatedAt?: string; retiredAt?: string | null; createdBy: { name: string }; processingJob?: { status: string } | null;
  variants: Array<{ variantKey: string; width: number; height: number; byteSize: number; sha256Checksum: string; storageKey: string }>;
};
type OptimisticUpload = { id: string; kind: "IMAGE"; originalFilename: string; byteSize: number };

const normalize = (asset: MediaRow) => ({ ...asset, referenceCount: asset.referenceCount ?? 0, references: asset.references ?? [], variants: asset.variants ?? [] });
const previewUrl = (asset: MediaRow, thumbnail = false) => asset.status === "READY" && asset.compatibilityFilename
  ? `/assets/uploads/files/${thumbnail ? "thumbnails/256/" : ""}${asset.compatibilityFilename}`
  : asset.sourceStorageKey ? `/api/admin/media/${asset.id}/source` : null;

type MediaPage = { items: MediaRow[]; total: number; page: number; pageCount: number; limit: number; counts: { active: number; retired: number } };

export function MediaManager({ role, initialBrowse, initialPage }: { role: string; initialBrowse: MediaBrowseState; initialPage?:MediaPage }) {
  const [browse, setBrowse] = useState(initialBrowse);
  const { view, kind: filter, page } = browse;
  const browseKey = mediaBrowseQuery(browse).toString();
  const browseKeyRef = useRef(browseKey);
  const [listing, setListing] = useState<{ key: string; data: MediaPage } | null>(()=>initialPage?{key:mediaBrowseQuery(initialBrowse).toString(),data:{...initialPage,items:initialPage.items.map(normalize)}}:null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(!initialPage);
  const initialKey=useRef(initialPage?browseKey:null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ key: string; asset: MediaRow } | null>(null);
  const [detailError, setDetailError] = useState("");
  const [optimistic, setOptimistic] = useState<OptimisticUpload[]>([]);
  const [pendingAction, setPendingAction] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const canUpload = role !== "VIEWER";
  const currentPage = listing?.key === browseKey ? listing.data : null;
  const visibleAssets = currentPage?.items ?? [];
  const selectedRow = visibleAssets.find(({ id }) => id === selectedId) ?? null;
  const visibleSelectedId = selectedRow?.id ?? null;
  const detailKey = `${browseKey}:${selectedId}:${selectedRow?.status}:${refreshVersion}`;
  const selected = selectedRow && detail?.key === detailKey ? detail.asset : selectedRow;
  const referencesLoaded = Boolean(selected && detail?.key === detailKey);
  const visibleOptimistic = view === "ACTIVE" && filter !== "AUDIO" && page === 1 ? optimistic : [];

  useEffect(() => {
    const onPopState = () => {
      const next = parseMediaBrowse(new URLSearchParams(window.location.search));
      browseKeyRef.current = mediaBrowseQuery(next).toString();
      setBrowse(next); setSelectedId(null); setDetail(null); setDetailError(""); setConfirmDelete(false); setError("");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/admin/media?${browseKey}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!active) return;
        if (!response.ok) throw new Error(body.error?.message ?? "Could not load media.");
        const next = body as MediaPage;
        setError("");
        setListing({ key: browseKey, data: { ...next, items: next.items.map(normalize) } });
        setLoading(false);
        // Deletion or a stale bookmarked page can reduce the number of pages.
        if (next.page !== parseMediaBrowse(new URLSearchParams(browseKey)).page) {
          const corrected = { ...parseMediaBrowse(new URLSearchParams(browseKey)), page: next.page };
          const key = mediaBrowseQuery(corrected).toString();
          browseKeyRef.current = key;
          window.history.replaceState(null, "", `${window.location.pathname}${key ? `?${key}` : ""}`);
          setBrowse(corrected);
        } else if (next.items.some((asset) => asset.status === "PROCESSING")) {
          timer = setTimeout(refresh, 1_500);
        }
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Could not load media."); setLoading(false);
        timer = setTimeout(refresh, 5_000);
      }
    };
    if(!(initialKey.current===browseKey && refreshVersion===0 && initialPage && !initialPage.items.some(asset=>asset.status==="PROCESSING"))) {initialKey.current=null;void refresh();}
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [browseKey, refreshVersion, initialPage]);

  useEffect(() => {
    if (!visibleSelectedId) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/admin/media/${visibleSelectedId}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!active) return;
        if (!response.ok) throw new Error(body.error?.message ?? "Could not load references.");
        setDetail({ key: detailKey, asset: normalize(body) }); setDetailError("");
      } catch (caught) {
        if (active) setDetailError(caught instanceof Error ? caught.message : "Could not load references.");
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [visibleSelectedId, detailKey]);

  function changeBrowseState(nextView: LibraryView, nextFilter: KindFilter, nextPage = 1) {
    const next = { view: nextView, kind: nextFilter, page: nextPage };
    const key = mediaBrowseQuery(next).toString();
    if (key === browseKeyRef.current) return;
    browseKeyRef.current = key;
    setBrowse(next); setSelectedId(null); setDetail(null); setDetailError(""); setConfirmDelete(false); setError(""); setLoading(true);
    window.history.pushState(null, "", `${window.location.pathname}${key ? `?${key}` : ""}`);
  }

  function updateAsset(asset: MediaRow) {
    setListing((current) => current ? { ...current, data: { ...current.data, items: current.data.items.map((row) => row.id === asset.id ? asset : row) } } : current);
    setRefreshVersion((version) => version + 1);
  }

  function releaseOptimistic(id: string) {
    setOptimistic((current) => current.filter((item) => item.id !== id));
  }

  async function onUpload(event: ChangeEvent<HTMLInputElement>, kind: "IMAGE" | "AUDIO") {
    const file = event.target.files?.[0]; if (!file) return;
    const temporaryId = kind === "IMAGE" ? `optimistic:${crypto.randomUUID()}` : null;
    if (temporaryId) {
      setOptimistic((current) => [{ id: temporaryId, kind: "IMAGE", originalFilename: file.name, byteSize: file.size }, ...current]);
    }
    const uploadFilter = filter === "ALL" || filter === kind ? filter : "ALL";
    if (view !== "ACTIVE" || uploadFilter !== filter || page !== 1) changeBrowseState("ACTIVE", uploadFilter);
    const uploadBrowseKey = mediaBrowseQuery({ view: "ACTIVE", kind: uploadFilter, page: 1 }).toString();
    const data = new FormData(); data.set("kind", kind); data.set("file", file);
    setUploadingCount((count) => count + 1); setError("");
    try {
      const response = await fetch("/api/admin/media", { method: "POST", body: data });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Upload failed.");
      const asset = normalize(body as MediaRow);
      if (browseKeyRef.current === uploadBrowseKey) {
        setListing((current) => current?.key === uploadBrowseKey ? { ...current, data: { ...current.data, items: [asset, ...current.data.items.filter(({ id }) => id !== asset.id)].slice(0, current.data.limit) } } : current);
        setSelectedId(asset.id); setDetail(null); setConfirmDelete(false);
      }
      setRefreshVersion((version) => version + 1);
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
      const asset = normalize(body as MediaRow); updateAsset(asset);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Retry failed."); }
    finally { setPendingAction(false); }
  }

  async function retire() {
    if (!selected) return; setPendingAction(true); setError("");
    try {
      const response = await fetch(`/api/admin/media/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retire" }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Retire failed.");
      setRefreshVersion((version) => version + 1);
      setSelectedId(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Retire failed."); }
    finally { setPendingAction(false); }
  }

  async function deletePermanently() {
    if (!selected) return; setPendingAction(true); setError("");
    try {
      const response = await fetch(`/api/admin/media/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deletePermanently" }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Permanent deletion failed.");
      setRefreshVersion((version) => version + 1); setSelectedId(null); setConfirmDelete(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Permanent deletion failed."); setConfirmDelete(false); }
    finally { setPendingAction(false); }
  }

  const deleteBlocked = Boolean(selected && (selected.referenceCount > 0 || selected.processingJob?.status === "RUNNING"));
  return <>
    <div className="cms-form-design cms-list-design cms-media-list">
    <section className="panel media-toolbar">
      <div className="media-toolbar-heading"><div className="eyebrow">Library</div><h2>Media assets</h2></div>
      <div className="media-toolbar-actions">
        <div className="media-tabs" role="tablist" aria-label="Media lifecycle"><button type="button" role="tab" disabled={pendingAction} aria-selected={view === "ACTIVE"} onClick={() => changeBrowseState("ACTIVE", filter)}>Active {currentPage && <span>{currentPage.counts.active}</span>}</button><button type="button" role="tab" disabled={pendingAction} aria-selected={view === "RETIRED"} onClick={() => changeBrowseState("RETIRED", filter)}>Retired {currentPage && <span>{currentPage.counts.retired}</span>}</button></div>
        <select className="media-kind-filter" aria-label="Kind filter" disabled={pendingAction} value={filter} onChange={(event) => changeBrowseState(view, event.target.value as KindFilter)}><option value="ALL">All</option><option value="IMAGE">Images</option><option value="AUDIO">Audio</option></select>
        {canUpload && <div className="button-row"><label className="button primary">{uploadingCount ? "Uploading…" : "Upload image"}<input className="media-upload-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => onUpload(event, "IMAGE")} /></label><label className="button">Upload MP3<input className="media-upload-input" type="file" accept="audio/mpeg,.mp3" onChange={(event) => onUpload(event, "AUDIO")} /></label></div>}
      </div>
    </section>
    {error && <div className="alert error" role="alert">{error}</div>}
    <section className="panel table-panel media-library-panel" aria-busy={loading || !currentPage}>
      <div className="button-row" aria-label="Media pagination">
        <button className="button" disabled={pendingAction || loading || !currentPage || page <= 1} onClick={() => changeBrowseState(view, filter, page - 1)}>Previous</button>
        <span role="status">{currentPage ? `${currentPage.total ? (currentPage.page - 1) * currentPage.limit + 1 : 0}–${Math.min(currentPage.page * currentPage.limit, currentPage.total)} of ${currentPage.total} results · Page ${currentPage.page} of ${currentPage.pageCount}` : "Loading media…"}</span>
        <button className="button" disabled={pendingAction || loading || !currentPage || page >= currentPage.pageCount} onClick={() => changeBrowseState(view, filter, page + 1)}>Next</button>
      </div>
      {!visibleOptimistic.length && !visibleAssets.length ? !currentPage ? null : <div className="empty media-empty"><strong>{view === "RETIRED" ? "No retired media assets." : "No active media assets yet."}</strong><span>{view === "RETIRED" ? "Retired assets remain available here until permanently deleted." : "Upload an image or MP3 to create the first asset."}</span></div> : <div role="table" aria-label="Media assets" className="media-table">
        <div role="row" className="table-row table-head media-columns">{["Name / Filename", "Type", "Status", "References", "Updated", "Actions"].map(label => <span role="columnheader" key={label}>{label}</span>)}</div>
        {visibleOptimistic.map((item) => <div role="row" className="table-row media-columns media-row optimistic" data-optimistic="true" aria-disabled="true" key={item.id}><span role="cell"><strong>{item.originalFilename}</strong></span><span role="cell" data-label="Type">Image</span><span role="cell" data-label="Status"><i className="status uploading">UPLOADING</i></span><span role="cell" data-label="References">—</span><span role="cell" data-label="Updated">—</span><span role="cell">Sending source…</span></div>)}
        {visibleAssets.map((asset) => {
          const name = asset.originalFilename ?? asset.compatibilityFilename ?? asset.legacyAudioId ?? (asset.kind === "AUDIO" ? "External audio" : "Unnamed image");
          return <div role="row" className={`table-row media-columns media-row${selected?.id === asset.id ? " selected" : ""}`} key={asset.id}>
            <span role="cell"><strong>{name}</strong>{asset.kind === "AUDIO" && asset.legacyAudioId && asset.legacyAudioId !== name && <small>{asset.legacyAudioId}</small>}</span>
            <span role="cell" data-label="Type">{asset.kind === "IMAGE" ? "Image" : "Audio"}</span>
            <span role="cell" data-label="Status"><i className={`status ${asset.status.toLowerCase()}`}>{asset.status}</i></span>
            <span role="cell" data-label="References">{asset.referenceCount}</span>
            <span role="cell" data-label="Updated">{formatCmsDate(asset.updatedAt ?? asset.retiredAt ?? asset.createdAt)}</span>
            <span role="cell"><button type="button" className="button media-open" aria-label={`Open ${name}`} aria-pressed={selected?.id === asset.id} disabled={pendingAction} onClick={() => { setSelectedId(asset.id); setDetailError(""); setConfirmDelete(false); }}>Open</button></span>
          </div>;
        })}
      </div>}
    </section>
    </div>
    {selected && <section className="panel preview media-detail">
      <div className="media-detail-heading"><div><div className="eyebrow">{selected.kind} detail</div><h2>Asset details</h2></div><i className={`status ${selected.status.toLowerCase()}`}>{selected.status}</i></div>
      <div className="media-detail-grid">
        <div className="media-detail-preview">{selected.kind === "IMAGE" && previewUrl(selected) ? <img className="detail-artwork" src={previewUrl(selected)!} alt={selected.originalFilename ?? "Artwork"} /> : selected.kind === "AUDIO" && selected.sourceStorageKey ? <audio controls preload="metadata" src={selected.status === "READY" && selected.legacyAudioId ? `/legacy-audio/${selected.legacyAudioId}-high.mp3` : `/api/admin/media/${selected.id}/source`} /> : <div className="empty-inline">No stored preview is available.</div>}</div>
        <div className="media-detail-data"><dl><dt>MediaAsset ID</dt><dd className="mono">{selected.id}</dd><dt>Kind</dt><dd>{selected.kind}</dd><dt>Status</dt><dd>{selected.status}</dd>{selected.status === "FAILED" && <><dt>Failure</dt><dd>{selected.failureReason ?? "Representation processing failed."}</dd></>}<dt>MIME</dt><dd>{selected.mimeType ?? "External"}</dd>{selected.kind === "IMAGE" ? <><dt>Dimensions</dt><dd>{selected.width}×{selected.height}</dd><dt>Compatibility filename</dt><dd className="mono">{selected.compatibilityFilename}</dd></> : <><dt>Duration</dt><dd>{formatAudioDuration(selected.durationMs)}</dd><dt>Compatibility audio ID</dt><dd className="mono">{selected.legacyAudioId}</dd></>}<dt>Size</dt><dd>{selected.byteSize === null ? "External" : `${(selected.byteSize / 1024).toFixed(1)} KB`}</dd><dt>Creator</dt><dd>{selected.createdBy.name}</dd><dt>Created</dt><dd>{formatCmsDate(selected.createdAt)}</dd>{selected.retiredAt && <><dt>Retired</dt><dd>{formatCmsDate(selected.retiredAt)}</dd></>}<dt>Checksum</dt><dd className="mono">{selected.sha256Checksum ?? "Not materialized"}</dd><dt>Storage key</dt><dd className="mono">{selected.sourceStorageKey ?? "External legacy reference"}</dd><dt>References</dt><dd>{selected.referenceCount}</dd></dl></div>
      </div>
      {!referencesLoaded && <p role="status">{detailError || "Loading asset details and references…"}</p>}
      {referencesLoaded && selected.references.length > 0 && <div className="media-detail-section"><h3>Blocking references</h3><ul>{selected.references.map((reference) => <li key={`${reference.type}-${reference.id}`}><strong>{reference.type}</strong> — {reference.name ?? reference.title ?? `revision ${reference.revisionNumber}`}</li>)}</ul></div>}
      {referencesLoaded && selected.kind === "IMAGE" && selected.variants.length > 0 && <div className="media-detail-section"><h3>Variants</h3><div className="media-variant-grid">{selected.variants.map((variant) => <p key={variant.variantKey}><strong>{variant.variantKey}</strong><br/><span className="mono">{variant.storageKey}</span><br/>{variant.width}×{variant.height} · {variant.byteSize} bytes<br/><span className="mono">{variant.sha256Checksum}</span></p>)}</div></div>}
      {selected.status === "FAILED" && canUpload && <div className="media-detail-actions"><button className="button primary" onClick={retryProcessing} disabled={pendingAction}>{pendingAction ? "Retrying…" : "Retry processing"}</button></div>}
      {role === "ADMIN" && selected.referenceCount === 0 && !["RETIRED", "PROCESSING"].includes(selected.status) && <div className="media-detail-actions"><button className="button danger" onClick={retire} disabled={pendingAction || !referencesLoaded}>Retire</button></div>}
      {role === "ADMIN" && selected.status === "RETIRED" && <div className="media-detail-actions permanent-delete-actions"><div>{deleteBlocked && <small>Permanent deletion is blocked by {selected.referenceCount ? `${selected.referenceCount} content reference${selected.referenceCount === 1 ? "" : "s"}` : "a running processing job"}.</small>}</div><button className="button danger" onClick={() => setConfirmDelete(true)} disabled={pendingAction || !referencesLoaded || deleteBlocked}>Delete permanently</button></div>}
    </section>}
    {confirmDelete && selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmDelete(false); }}><section className="panel confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="delete-media-title"><div className="eyebrow">Destructive action</div><h2 id="delete-media-title">Delete permanently?</h2><p>This permanently removes:</p><ul><li>the uploaded source</li><li>all generated variants</li><li>the database media record</li></ul><p><strong>This cannot be undone.</strong></p><div className="button-row"><button className="button" onClick={() => setConfirmDelete(false)} disabled={pendingAction}>Cancel</button><button className="button danger" onClick={deletePermanently} disabled={pendingAction}>{pendingAction ? "Deleting…" : "DELETE PERMANENTLY"}</button></div></section></div>}
  </>;
}
