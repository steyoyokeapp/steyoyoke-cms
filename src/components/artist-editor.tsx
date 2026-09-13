"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { SecondarySections } from "./secondary-sections";
import { ArtworkPicker, type ArtworkOption } from "@/components/artwork-picker";

type Revision = { id:string; revisionNumber:number; sourceWorkingVersion:number };
export type ArtistEditorData = {
  id: string; legacyId: number; name: string; slug: string; shortBio: string | null;
  facebookUrl: string | null; imageAssetId: string | null; status: string; workingVersion: number; revisionCount:number; scheduledFor: string | null;
  publishedRevision: Revision | null; scheduledRevision: Revision | null;

};

async function readResult(response: Response) {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "The operation failed.");
  return result;
}
const displayDate = (value: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));

export function ArtistEditor({ artist, role, mediaAssets }: { artist: ArtistEditorData; role: string; mediaAssets: ArtworkOption[] }) {
  const router = useRouter();
  const canWrite = role !== "VIEWER";
  const isAdmin = role === "ADMIN";
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState(artist.name);
  const [slug, setSlug] = useState(artist.slug);
  const [shortBio, setShortBio] = useState(artist.shortBio ?? "");
  const [facebookUrl, setFacebookUrl] = useState(artist.facebookUrl ?? "");
  const [imageAssetId, setImageAssetId] = useState<string | null>(artist.imageAssetId);
  const [scheduledFor, setScheduledFor] = useState("");

  async function perform(action: string, extra: Record<string, unknown> = {}) {
    setPending(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/admin/artists/${artist.id}/actions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      await readResult(response);
      if (action === "hardDelete") {
        router.replace("/admin/artists"); router.refresh(); return;
      }
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The operation failed.");
      setPending(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/admin/artists/${artist.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug, shortBio, facebookUrl, imageAssetId, expectedWorkingVersion: artist.workingVersion }),
      });
      await readResult(response);
      setMessage("Draft saved. Published and scheduled snapshots were not changed.");
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save draft.");
      setPending(false);
    }
  }

  return (
    <div className="editor-grid">
      <div className="editor-column">
        <section className="panel summary-strip">
          <span><small>Legacy ID</small><strong className="mono">{artist.legacyId}</strong></span>
          <span><small>Status</small><i className={`status ${artist.status.toLowerCase()}`}>{artist.status}</i></span>
          <span><small>Working version</small><strong className="mono">v{artist.workingVersion}</strong></span>
          <span><small>Published revision</small><strong className="mono">{artist.publishedRevision ? `r${artist.publishedRevision.revisionNumber}` : "—"}</strong></span>
        </section>
        <form className="panel editor-form" onSubmit={save}>
          <label>Artist name<input value={name} onChange={(event) => setName(event.target.value)} readOnly={!canWrite} required /></label>
          <label>Slug<input value={slug} onChange={(event) => setSlug(event.target.value)} readOnly={!canWrite} required /></label>
          <label>Short biography<textarea rows={7} value={shortBio} onChange={(event) => setShortBio(event.target.value)} readOnly={!canWrite} /></label>
          <label>Facebook URL<input type="url" value={facebookUrl} onChange={(event) => setFacebookUrl(event.target.value)} readOnly={!canWrite} /></label>
          {error && <div className="alert error" role="alert">{error}</div>}
          {message && <div className="alert success" role="status">{message}</div>}
          {canWrite && artist.status !== "ARCHIVED" && <div className="button-row"><button className="button primary" disabled={pending}>Save draft</button></div>}
        </form>
        <ArtworkPicker value={imageAssetId} assets={mediaAssets} canWrite={canWrite && artist.status !== "ARCHIVED"} onChange={setImageAssetId} />
        {canWrite && <section className="panel publish-panel">
          <div><h2>Publication</h2><p className="muted">Snapshots are frozen. Save the draft before publishing or scheduling.</p></div>
          <div className="button-row wrap">
            {artist.status !== "ARCHIVED" && <button className="button" disabled={pending} onClick={() => perform("publish", { expectedWorkingVersion: artist.workingVersion })}>Publish now</button>}
            {artist.status === "PUBLISHED" && <button className="button" disabled={pending} onClick={() => perform("unpublish")}>Unpublish</button>}
            {artist.status !== "ARCHIVED" && artist.status !== "SCHEDULED" && <><input aria-label="Schedule time" type="datetime-local" value={scheduledFor} onInput={(event) => setScheduledFor(event.currentTarget.value)} /><button className="button" disabled={pending || !scheduledFor} onClick={() => perform("schedule", { scheduledFor: new Date(scheduledFor).toISOString(), expectedWorkingVersion: artist.workingVersion })}>Schedule</button></>}
            {artist.status === "SCHEDULED" && <button className="button" disabled={pending} onClick={() => perform("cancelSchedule")}>Cancel schedule</button>}
            {artist.status === "ARCHIVED" ? <button className="button" disabled={pending} onClick={() => perform("restore")}>Restore</button> : <button className="button danger" disabled={pending} onClick={() => perform("archive")}>Archive</button>}
            {isAdmin && artist.status === "DRAFT" && artist.revisionCount === 0 && <button className="button danger" disabled={pending} onClick={() => confirm("Permanently delete this never-published draft?") && perform("hardDelete")}>Delete permanently</button>}
          </div>
          {artist.scheduledFor && <p className="schedule-note">Scheduled for {displayDate(artist.scheduledFor)} UTC.</p>}
        </section>}
      </div>
      <SecondarySections kind="artists" id={artist.id} version={artist.workingVersion} />
    </div>
  );
}
