"use client";
import { useEffect, useRef, useState } from "react";
import type { AudioOption } from "./audio-picker";
import type { ArtworkOption } from "./artwork-picker";
import { formatDuration } from "@/modules/tracks/duration";
import { TRACK_AUDIO_MAX_BYTES, trackAudioFilename } from "@/modules/media/track-audio-contract";
async function body(response: Response) { const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? "Upload failed."); return value; }
export function TrackMediaUpload({ kind, initial, disabled, onReady, onBusy }: { kind: "audio" | "artwork"; initial?: AudioOption | ArtworkOption; disabled: boolean; onReady: (asset: AudioOption & ArtworkOption) => void; onBusy: (busy: boolean) => void }) {
  const [selected, setSelected] = useState(initial); const [state, setState] = useState(""); const [error, setError] = useState(""); const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function upload(file: File) {
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    const signal = (milliseconds = 60_000) => AbortSignal.any([abort.signal, AbortSignal.timeout(milliseconds)]);
    setError(""); setState("UPLOADING"); onBusy(true);
    try {
      let asset;
      if (kind === "audio") {
        trackAudioFilename(file.name);
        if (file.size > TRACK_AUDIO_MAX_BYTES) throw new Error("Choose audio no larger than 512 MiB.");
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
        const reservation = await body(await fetch("/api/admin/tracks/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, size: file.size, sha256 }), signal: signal() }));
        const uploaded = await fetch(reservation.url, { method: "PUT", headers: reservation.headers, body: file, signal: signal(600_000) });
        if (!uploaded.ok) throw new Error("Audio upload failed. Please try again.");
        asset = await body(await fetch(`/api/admin/tracks/audio/${reservation.id}`, { method: "POST", signal: signal() }));
      } else {
        const data = new FormData(); data.set("file", file);
        asset = await body(await fetch("/api/admin/media", { method: "POST", body: data, signal: signal() }));
      }
      setState(asset.status);
      const deadline = Date.now() + 20 * 60_000;
      for (let attempt = 0; asset.status !== "READY" && asset.status !== "FAILED" && attempt < 240 && Date.now() < deadline; attempt++) {
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { abort.signal.removeEventListener("abort", cancel); resolve(); }, 5000); function cancel() { clearTimeout(timer); reject(new Error("Upload cancelled")); } abort.signal.addEventListener("abort", cancel, { once: true }); });
        if (abort.signal.aborted) return;
        asset = await body(await fetch(kind === "audio" ? `/api/admin/tracks/audio/${asset.id}` : `/api/admin/media/${asset.id}`, { cache: "no-store", signal: signal() }));
        setState(asset.status);
      }
      if (asset.status !== "READY") throw new Error(asset.status === "FAILED" ? "Processing failed. Please upload again with a new filename." : "Processing is taking longer than expected. Contact an administrator before uploading again.");
      setSelected(asset); onReady(asset);
    } catch (caught) { if (!abort.signal.aborted) { setState("FAILED"); setError(caught instanceof Error ? caught.message : "Upload failed."); } }
    finally { if (!abort.signal.aborted) onBusy(false); }
  }
  const audio = kind === "audio" ? selected as AudioOption | undefined : undefined;
  const artwork = kind === "artwork" ? selected as ArtworkOption | undefined : undefined;
  return <section>
    <h2>{kind === "audio" ? "Audio" : "Artwork"}</h2>
    {selected && <p style={{ overflowWrap: "anywhere" }}>{selected.originalFilename ?? (audio?.legacyAudioId || "Current artwork")}</p>}
    {audio?.legacyAudioId && <><audio controls preload="none" style={{ width: "100%", maxWidth: 400 }} src={audio.status === "EXTERNAL" ? `https://steyoyokeapp.s3.eu-west-1.amazonaws.com/${encodeURIComponent(audio.legacyAudioId)}-high.mp3` : `/legacy-audio/${encodeURIComponent(audio.legacyAudioId)}-high.mp3`} /><p>Duration: {formatDuration(audio.durationMs) ?? "Unavailable for this historical audio"}</p></>}
    {artwork?.compatibilityFilename && <img width={160} height={160} style={{ objectFit: "contain" }} alt="Track artwork" src={`/assets/uploads/files/thumbnails/256/${artwork.compatibilityFilename}`} />}
    {!disabled && <label className="button">{selected ? `Replace ${kind}` : `Upload ${kind}`}<input hidden type="file" accept={kind === "audio" ? ".wav,.mp3" : "image/jpeg,image/png,image/webp"} disabled={state === "UPLOADING" || state === "PROCESSING"} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} /></label>}
    {state && <p role="status" aria-label={`${kind} processing status`}>{state}</p>}{error && <p className="alert error" role="alert">{error}</p>}
  </section>;
}
