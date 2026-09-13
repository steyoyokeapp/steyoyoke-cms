"use client";

import { authClient } from "@/lib/auth-client";

export function UserMenu({ name, role }: { name: string; role: string }) {
  return (
    <div className="user-menu">
      <span><strong>{name}</strong><small>{role}</small></span>
      <button className="text-button" onClick={async () => {
        await authClient.signOut();
        window.location.replace("/sign-in");
      }}>Sign out</button>
    </div>
  );
}
