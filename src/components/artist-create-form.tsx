"use client";

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
    const response = await fetch("/api/admin/artists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        slug: form.get("slug"),
        shortBio: form.get("shortBio"),
        facebookUrl: form.get("facebookUrl"),
      }),
    });
    const result = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(result.error?.message ?? "Could not create artist.");
      return;
    }
    router.push(`/admin/artists/${result.id}`);
    router.refresh();
  }
  return (
    <form className="panel editor-form" onSubmit={submit}>
      <label>Artist name<input name="name" required maxLength={160} autoFocus /></label>
      <label>Slug <span className="hint">Optional; generated from the name</span><input name="slug" maxLength={180} /></label>
      <label>Short biography<textarea name="shortBio" rows={6} maxLength={2000} /></label>
      <label>Facebook URL<input name="facebookUrl" type="url" /></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="button-row"><button className="button primary" disabled={pending}>{pending ? "Creating…" : "Create draft"}</button></div>
    </form>
  );
}
