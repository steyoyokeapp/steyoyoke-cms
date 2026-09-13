"use client";
import Link, { useLinkStatus } from "next/link";
import type { ReactNode } from "react";

function PendingHint() {
  const { pending } = useLinkStatus();
  return <span role="status" className="navigation-pending">{pending ? "Loading…" : ""}</span>;
}

/** Feedback lives in the current page; it does not suspend ready destination content. */
export function NavigationLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href}>{children}<PendingHint /></Link>;
}
