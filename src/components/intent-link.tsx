"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
/** Next owns its bounded prefetch scheduler. Never prefetch every visible catalogue row. */
export function IntentLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      href={href}
      className={className}
      prefetch={intent ? true : false}
      onMouseEnter={() => setIntent(true)}
      onFocus={() => setIntent(true)}
      onMouseLeave={() => setIntent(false)}
      onBlur={() => setIntent(false)}
    >
      {children}
    </Link>
  );
}
