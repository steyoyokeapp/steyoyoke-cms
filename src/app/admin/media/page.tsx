import { redirect } from "next/navigation";
import { mediaBrowseQuery } from "@/modules/media/browse";
import { Suspense } from "react";
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
  const actor = await actorForPage(await headers());
  const query = await searchParams;
  const browse = parseMediaBrowse(
    new URLSearchParams(
      Object.entries(query).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    ),
  );
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">Content</div>
          <h1>Media</h1>
          <p className="muted">Managed image and audio assets.</p>
        </div>
      </section>
      <Suspense
        fallback={
          <section className="panel" aria-busy="true">
            <h2>Media assets</h2>
            <p>Loading media…</p>
          </section>
        }
      >
        <InitialMedia actor={actor} browse={browse} />
      </Suspense>
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
