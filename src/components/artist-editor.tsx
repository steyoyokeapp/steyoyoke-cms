"use client";
import "./cms-form-design.css";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export type ArtistEditorData = {
  id: string;
  name: string;
  status: string;
  workingVersion: number;
};

export function ArtistEditor({ artist, role }: { artist: ArtistEditorData; role: string }) {
  const router = useRouter();
  const canWrite = role !== "VIEWER" && artist.status !== "ARCHIVED";
  const [name, setName] = useState(artist.name);
  const [version, setVersion] = useState(artist.workingVersion);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/admin/artists/${artist.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, expectedWorkingVersion: version }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Could not save changes.");
      setName(result.name);
      setVersion(result.workingVersion);
      setMessage("Changes saved.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save changes.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="panel editor-form catalogue-editor cms-form-design cms-artist-form" onSubmit={save}>
      <label>Artist name<input placeholder="Artist name" name="name" value={name} onChange={(event) => setName(event.target.value)} readOnly={!canWrite} required maxLength={160} /></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      {message && <div className="alert success" role="status">{message}</div>}
      {canWrite && <div className="button-row"><button className="button primary" disabled={pending}>{pending ? "Saving…" : "Save changes"}</button></div>}
    </form>
  );
}
