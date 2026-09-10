import { localStorage } from "@/modules/media/storage";
import { resolveLegacyMedia } from "@/modules/media/service";

const routes: Record<string, string> = {
  "": "ORIGINAL", "1440": "LEGACY_1440", "1024": "LEGACY_1024", "512": "LEGACY_512",
  "thumbnails/256": "LEGACY_THUMB_256", "thumbnails/80": "LEGACY_THUMB_80",
};

export async function GET(_request: Request, context: RouteContext<"/assets/uploads/files/[...path]">) {
  const parts = (await context.params).path;
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) return new Response("Not found", { status: 404 });
  const filename = parts.at(-1)!; const folder = parts.slice(0, -1).join("/"); const variantKey = routes[folder];
  if (!variantKey) return new Response("Not found", { status: 404 });
  const variant = await resolveLegacyMedia(filename, variantKey); if (!variant) return new Response("Not found", { status: 404 });
  try { return new Response(new Uint8Array(await localStorage.read(variant.storageKey)), { headers: { "Content-Type": variant.mimeType, "Content-Length": String(variant.byteSize), "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } }); }
  catch { return new Response("Not found", { status: 404 }); }
}
