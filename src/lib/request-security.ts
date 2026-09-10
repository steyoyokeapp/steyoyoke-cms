import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";

export function requireTrustedMutation(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new AppError("A same-origin request is required.", 403, "UNTRUSTED_ORIGIN");
  const configured = new URL(env.BETTER_AUTH_URL).origin;
  const allowed = new Set([
    configured,
    configured.replace("localhost", "127.0.0.1"),
    new URL(request.url).origin,
  ]);
  if (!allowed.has(origin)) throw new AppError("Request origin is not trusted.", 403, "UNTRUSTED_ORIGIN");
}
