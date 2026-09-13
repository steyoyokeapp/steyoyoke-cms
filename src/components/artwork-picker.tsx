"use client";

import { useState, type ChangeEvent } from "react";

export type ArtworkOption = { id: string; originalFilename: string | null; compatibilityFilename: string; width: number; height: number; status: string };

async function upload(file: File) {
  const data = new FormData(); data.set("file", file); const response = await fetch("/api/admin/media", { method: "POST", body: data }); const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "Upload failed."); return body as ArtworkOption;
}

async function waitForReady(id: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    const response = await fetch(`/api/admin/media/${id}`, { cache: "no-store" });
    if (!response.ok) continue;
    const asset = await response.json() as ArtworkOption;
    if (asset.status === "READY" || asset.status === "FAILED") return asset;
  }
  return null;
}

export function ArtworkPicker({ value, assets, canWrite, requiredForPublish, onChange }: { value: string | null; assets: ArtworkOption[]; canWrite: boolean; requiredForPublish?: boolean; onChange: (id: string | null) => void }) {
  const [options, setOptions] = useState(assets); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const selected = options.find((asset) => asset.id === value);
  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return; setPending(true); setError("");
    try {
      const asset = await upload(file); setOptions((current) => [asset, ...current.filter(({ id }) => id !== asset.id)]); setPending(false);
      if (asset.status === "READY") onChange(asset.id);
      else void waitForReady(asset.id).then((finished) => {
        if (!finished) return setError("Image is still processing. It will be available in the Media library when ready.");
        setOptions((current) => current.map((value) => value.id === finished.id ? finished : value));
        if (finished.status === "READY") onChange(finished.id); else setError("Image processing failed. Retry it from the Media library.");
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed."); } finally { setPending(false); event.target.value = ""; }
  }
  return <section className="panel media-picker"><div className="eyebrow">Media</div><h2>Artwork</h2><p className="muted">{requiredForPublish ? "A READY image is required for Publish and Schedule." : "Artwork is optional; selected media must be READY."}</p>
    {selected && <div className="media-preview"><img src={`/assets/uploads/files/thumbnails/256/${selected.compatibilityFilename}`} alt="Selected artwork preview" /><span><strong>{selected.originalFilename ?? "Imported artwork"}</strong><small>{selected.width}×{selected.height} · {selected.status}</small></span></div>}
    <label>READY image<select aria-label="Artwork" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} disabled={!canWrite || pending}><option value="">{requiredForPublish ? "No artwork selected" : "None"}</option>{selected && selected.status !== "READY" && <option value={selected.id} disabled>{selected.originalFilename ?? "Attached media"} · {selected.status} (current)</option>}{options.filter((asset) => asset.status === "READY").map((asset) => <option key={asset.id} value={asset.id}>{asset.originalFilename ?? "Imported artwork"} · {asset.width}×{asset.height}</option>)}</select></label>
    {canWrite && <label className="button">{pending ? "Processing…" : "Upload image"}<input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={onUpload} disabled={pending} /></label>}
    {error && <div className="alert error" role="alert">{error}</div>}
  </section>;
}
