"use client";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function PendingHint() {
  const { pending } = useLinkStatus();
  return <span role="status" className="navigation-pending">{pending ? "Loading…" : ""}</span>;
}

/** Feedback lives in the current page; it does not suspend ready destination content. */
export function NavigationLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  return <Link href={href} aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined}>{children}<PendingHint /></Link>;
}
