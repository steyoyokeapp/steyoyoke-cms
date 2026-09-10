"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const result = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
      rememberMe: false,
    });
    setPending(false);
    if (result.error) {
      setError("The email or password is incorrect.");
      return;
    }
    router.replace("/admin/artists");
    router.refresh();
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <div className="eyebrow">Steyoyoke</div>
      <h1>Publishing control room</h1>
      <p className="muted">Sign in with a locally seeded CMS account.</p>
      <label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button className="button primary" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
