import { mediaStorage } from "@/modules/media/storage";
import { resolveLegacyAudio } from "@/modules/media/service";

function responseHeaders(asset: { mimeType: string; byteSize: number }) { return { "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": asset.mimeType, "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Content-Length": String(asset.byteSize) }; }

export async function GET(request: Request, context: RouteContext<"/legacy-audio/[filename]">) {
  const filename = (await context.params).filename; const match = /^([A-Za-z0-9_-]{1,200})-high\.mp3$/.exec(filename); if (!match) return new Response("Not found", { status: 404 });
  const asset = await resolveLegacyAudio(match[1]!); if (!asset) return new Response("Not found", { status: 404 });
  if (asset.audioDelivery) return Response.redirect(`https://steyoyokeapp.s3.eu-west-1.amazonaws.com/${encodeURIComponent(match[1]!)}-high.mp3`, 307);
  if (!asset.sourceStorageKey || !asset.mimeType || asset.byteSize === null) return new Response("Not found", { status: 404 });
  try {
    const bytes = await mediaStorage.read(asset.sourceStorageKey); const baseHeaders = responseHeaders({ mimeType: asset.mimeType, byteSize: asset.byteSize }); const range = request.headers.get("range");
    if (!range) return new Response(new Uint8Array(bytes), { headers: baseHeaders });
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range); if (!parsed || (!parsed[1] && !parsed[2])) return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${bytes.length}` } });
    const start = parsed[1] ? Number(parsed[1]) : Math.max(0, bytes.length - Number(parsed[2])); let end = parsed[2] && parsed[1] ? Number(parsed[2]) : bytes.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes.length || end < start) return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${bytes.length}` } });
    end = Math.min(end, bytes.length - 1); const body = bytes.subarray(start, end + 1);
    return new Response(new Uint8Array(body), { status: 206, headers: { ...baseHeaders, "Content-Length": String(body.length), "Content-Range": `bytes ${start}-${end}/${bytes.length}` } });
  } catch { return new Response("Not found", { status: 404 }); }
}
