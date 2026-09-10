import { headers } from "next/headers";
import { MediaManager } from "@/components/media-manager";
import { actorForPage } from "@/lib/session";
import { listMediaAssets } from "@/modules/media/service";

export default async function MediaPage() {
  const actor = await actorForPage(await headers()); const assets = await listMediaAssets(actor);
  return <><section className="page-heading"><div><div className="eyebrow">Library</div><h1>Media</h1><p className="muted">Local-only immutable image assets and compatibility variants.</p></div></section><MediaManager role={actor.role} initial={assets.map((asset) => ({ ...asset, createdAt: asset.createdAt.toISOString() }))} /></>;
}
