import { headers } from "next/headers";
import { MediaManager } from "@/components/media-manager";
import { actorForPage } from "@/lib/session";
import { parseMediaBrowse } from "@/modules/media/browse";

export default async function MediaPage({ searchParams }: PageProps<"/admin/media">) {
  const actor = await actorForPage(await headers());
  const query = await searchParams;
  const browse = parseMediaBrowse(new URLSearchParams(Object.entries(query).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])));
  return <><section className="page-heading"><div><div className="eyebrow">Content</div><h1>Media</h1><p className="muted">Managed image and audio assets.</p></div></section><MediaManager role={actor.role} initialBrowse={browse} /></>;
}
