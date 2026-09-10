"use client";

import { useState, type ChangeEvent } from "react";

export type ArtworkOption = { id: string; originalFilename: string; compatibilityFilename: string; width: number; height: number; status: string };

async function upload(file: File) {
  const data = new FormData(); data.set("file", file); const response = await fetch("/api/admin/media", { method: "POST", body: data }); const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "Upload failed."); return body as ArtworkOption;
}

export function ArtworkPicker({ value, assets, canWrite, requiredForPublish, onChange }: { value: string | null; assets: ArtworkOption[]; canWrite: boolean; requiredForPublish?: boolean; onChange: (id: string | null) => void }) {
  const [options, setOptions] = useState(assets); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const selected = options.find((asset) => asset.id === value);
  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return; setPending(true); setError("");
    try { const asset = await upload(file); setOptions([asset, ...options]); onChange(asset.id); } catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed."); } finally { setPending(false); event.target.value = ""; }
  }
  return <section className="panel media-picker"><div className="eyebrow">Media</div><h2>Artwork</h2><p className="muted">{requiredForPublish ? "A READY image is required for Publish and Schedule." : "Artwork is optional; selected media must be READY."}</p>
    {selected && <div className="media-preview"><img src={`/assets/uploads/files/thumbnails/256/${selected.compatibilityFilename}`} alt="Selected artwork preview" /><span><strong>{selected.originalFilename}</strong><small>{selected.width}×{selected.height} · {selected.status}</small></span></div>}
    <label>READY image<select aria-label="Artwork" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} disabled={!canWrite || pending}><option value="">{requiredForPublish ? "No artwork selected" : "None"}</option>{options.filter((asset) => asset.status === "READY").map((asset) => <option key={asset.id} value={asset.id}>{asset.originalFilename} · {asset.width}×{asset.height}</option>)}</select></label>
    {canWrite && <label className="button">{pending ? "Processing…" : "Upload image"}<input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={onUpload} disabled={pending} /></label>}
    {error && <div className="alert error" role="alert">{error}</div>}
  </section>;
}
