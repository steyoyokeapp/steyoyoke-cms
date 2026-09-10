import type { Role } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";

export type Actor = { userId: string; role: Role };
export type Permission = "artist:read" | "artist:write" | "artist:hard-delete" | "track:read" | "track:write" | "podcast:read" | "podcast:write" | "release:read" | "release:write" | "media:read" | "media:upload" | "media:retire" | "media:purge";

const permissions: Record<Role, ReadonlySet<Permission>> = {
  ADMIN: new Set(["artist:read", "artist:write", "artist:hard-delete", "track:read", "track:write", "podcast:read", "podcast:write", "release:read", "release:write", "media:read", "media:upload", "media:retire", "media:purge"]),
  EDITOR: new Set(["artist:read", "artist:write", "track:read", "track:write", "podcast:read", "podcast:write", "release:read", "release:write", "media:read", "media:upload"]),
  VIEWER: new Set(["artist:read", "track:read", "podcast:read", "release:read", "media:read"]),
};

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!permissions[actor.role].has(permission)) {
    throw new AppError("You do not have permission to perform this action.", 403, "FORBIDDEN");
  }
}
