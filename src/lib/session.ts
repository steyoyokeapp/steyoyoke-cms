import { revealTiming } from "./reveal-timing";
import { cache } from "react";
import { headers as requestHeaders } from "next/headers";
import { auth } from "@/lib/auth";
import type { Role } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { Actor } from "@/lib/authorization";
import { redirect } from "next/navigation";

const roles = new Set<Role>(["ADMIN", "EDITOR", "VIEWER"]);

export async function actorFromHeaders(headers: Headers): Promise<Actor> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new AppError("Authentication required.", 401, "UNAUTHENTICATED");
  const role = session.user.role as Role;
  if (!roles.has(role)) throw new AppError("Invalid account role.", 403, "INVALID_ROLE");
  return { userId: session.user.id, role };
}

export const sessionForPage = cache(async () => {
  const timing = revealTiming("cms_session");
  const session = await auth.api.getSession({headers: await requestHeaders()});
  timing.finish();
  return session;
});

export async function actorForPage(_headers?: Headers): Promise<Actor> {
  void _headers; // Kept for compatibility; Next request headers are resolved inside the per-render cache.
  try {
    const session=await sessionForPage();
    if(!session)throw new AppError("Authentication required.",401,"UNAUTHENTICATED");
    const role=session.user.role as Role;
    if(!roles.has(role))throw new AppError("Invalid account role.",403,"INVALID_ROLE");
    return {userId:session.user.id,role};
  } catch (error) {
    if (error instanceof AppError && error.status === 401) redirect("/sign-in");
    throw error;
  }
}
