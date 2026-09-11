import { headers } from "next/headers";
import { MediaManager } from "@/components/media-manager";
import { actorForPage } from "@/lib/session";
import { listMediaAssets } from "@/modules/media/service";

export default async function MediaPage({ searchParams }: PageProps<"/admin/media">) {
  const actor = await actorForPage(await headers()); const assets = await listMediaAssets(actor); const query = await searchParams;
  const initialView = query.view === "retired" ? "RETIRED" as const : "ACTIVE" as const;
  const initialFilter = query.kind === "IMAGE" || query.kind === "AUDIO" ? query.kind : "ALL" as const;
  return <><section className="page-heading"><div><div className="eyebrow">Content</div><h1>Media</h1><p className="muted">Managed image and audio assets.</p></div></section><MediaManager role={actor.role} initialView={initialView} initialFilter={initialFilter} initial={assets.map((asset) => ({ ...asset, createdAt: asset.createdAt.toISOString(), retiredAt: asset.retiredAt?.toISOString() ?? null }))} /></>;
}
