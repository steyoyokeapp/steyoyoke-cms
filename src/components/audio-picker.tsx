"use client";

import { useState, type ChangeEvent } from "react";
import { formatAudioDuration } from "@/modules/media/format";

export type AudioOption = { id: string; originalFilename: string | null; legacyAudioId: string | null; durationMs: number | null; status: string };

async function uploadAudio(file: File) { const data = new FormData(); data.set("kind", "AUDIO"); data.set("file", file); const response = await fetch("/api/admin/media", { method: "POST", body: data }); const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Upload failed."); return body as AudioOption; }

export function AudioPicker({ value, assets, canWrite, requiredForPublish, onChange }: { value: string | null; assets: AudioOption[]; canWrite: boolean; requiredForPublish?: boolean; onChange: (id: string | null) => void }) {
  const [options, setOptions] = useState(assets); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const selected = options.find((asset) => asset.id === value);
  async function onUpload(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; setPending(true); setError(""); try { const asset = await uploadAudio(file); setOptions([asset, ...options]); onChange(asset.id); } catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed."); } finally { setPending(false); event.target.value = ""; } }
  return <section className="panel media-picker"><div className="eyebrow">Media</div><h2>Audio</h2><p className="muted">{requiredForPublish ? "A READY MP3 is required for Publish and Schedule." : "Audio is optional; selected media must be a READY MP3."}</p>
    {selected && <div className="audio-preview"><span><strong>{selected.originalFilename ?? selected.legacyAudioId ?? "External audio"}</strong><small>{formatAudioDuration(selected.durationMs)} · {selected.status}</small></span>{selected.status === "READY" && selected.legacyAudioId && <audio controls preload="metadata" src={`/legacy-audio/${selected.legacyAudioId}-high.mp3`} />}</div>}
    <label>READY audio<select aria-label="Audio" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} disabled={!canWrite || pending}><option value="">{requiredForPublish ? "No audio selected" : "None"}</option>{options.filter((asset) => asset.status === "READY").map((asset) => <option key={asset.id} value={asset.id}>{asset.originalFilename ?? asset.legacyAudioId ?? "Audio"} · {formatAudioDuration(asset.durationMs)}</option>)}</select></label>
    {canWrite && <label className="button">{pending ? "Processing…" : "Upload MP3"}<input hidden type="file" accept="audio/mpeg,.mp3" onChange={onUpload} disabled={pending} /></label>}
    {error && <div className="alert error" role="alert">{error}</div>}
  </section>;
}
