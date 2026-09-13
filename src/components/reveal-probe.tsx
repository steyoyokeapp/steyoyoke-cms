"use client";
import { useEffect } from "react";

/** Enabled only by the server's isolated-test flag; never logs content or identifiers. */
export function RevealProbe({ kind }: { kind: "artists" | "podcasts" | "media" | "release" }) {
  useEffect(() => {
    const mounted = performance.now();
    const frame = requestAnimationFrame(() => {
      const selector = kind === "media" ? ".media-card" : kind === "release" ? ".summary-strip" : "a.table-row";
      const rows = document.querySelectorAll(selector);
      console.info(JSON.stringify({ event: "cms_client_reveal", mountMs: mounted, frameMs: performance.now(), renderedCount: [...rows].filter(row => row.getBoundingClientRect().height > 0).length }));
    });
    return () => cancelAnimationFrame(frame);
  }, [kind]);
  return null;
}
