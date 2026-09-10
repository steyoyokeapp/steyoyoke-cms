"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function UserMenu({ name, role }: { name: string; role: string }) {
  const router = useRouter();
  return (
    <div className="user-menu">
      <span><strong>{name}</strong><small>{role}</small></span>
      <button className="text-button" onClick={async () => {
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}>Sign out</button>
    </div>
  );
}
