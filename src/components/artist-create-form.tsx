"use client";
import "./cms-form-design.css";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function ArtistCreateForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/admin/artists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.get("name") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Could not create artist.");
      router.push(`/admin/artists/${result.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create artist.");
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="panel editor-form catalogue-editor cms-form-design cms-artist-form" onSubmit={submit}>
      <label>Artist name<input placeholder="Artist name" name="name" required maxLength={160} autoFocus /></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="button-row"><button className="button primary" disabled={pending}>{pending ? "Creating…" : "Create artist"}</button></div>
    </form>
  );
}
