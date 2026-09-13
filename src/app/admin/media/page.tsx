import { redirect } from "next/navigation";
import { mediaBrowseQuery } from "@/modules/media/browse";
import { revealTiming } from "@/lib/reveal-timing";
import { RevealProbe } from "@/components/reveal-probe";
import { listMediaAssets } from "@/modules/media/service";
import type { Actor } from "@/lib/authorization";
import type { MediaBrowseState } from "@/modules/media/browse";
import { headers } from "next/headers";
import { MediaManager } from "@/components/media-manager";
import { actorForPage } from "@/lib/session";
import { parseMediaBrowse } from "@/modules/media/browse";

export default async function MediaPage({
  searchParams,
}: PageProps<"/admin/media">) {
  const timing = revealTiming("cms_media_page");
  const actor = await actorForPage(await headers());
  timing.mark("sessionCompleteMs");
  const query = await searchParams;
  const browse = parseMediaBrowse(
    new URLSearchParams(
      Object.entries(query).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    ),
  );
  timing.mark("serviceStartMs");
  const initialMedia = await InitialMedia({ actor, browse });
  timing.mark("serviceAndConstructionEndMs");
  timing.finish();
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">Content</div>
          <h1>Media</h1>
          <p className="muted">Managed image and audio assets.</p>
        </div>
      </section>
      {initialMedia}
      {process.env.CMS_REVEAL_TIMING === "1" && <RevealProbe kind="media" />}
    </>
  );
}

async function InitialMedia({
  actor,
  browse,
}: {
  actor: Actor;
  browse: MediaBrowseState;
}) {
  const initialPage = await listMediaAssets(actor, browse);
  if (initialPage.page !== browse.page)
    redirect(
      `/admin/media?${mediaBrowseQuery({ ...browse, page: initialPage.page })}`,
    );
  return (
    <MediaManager
      role={actor.role}
      initialBrowse={browse}
      initialPage={{
        ...initialPage,
        items: initialPage.items.map((asset) => ({
          ...asset,
          createdAt: asset.createdAt.toISOString(),
          retiredAt: asset.retiredAt?.toISOString() ?? null,
          variants: [],
          references: [],
        })),
      }}
    />
  );
}
