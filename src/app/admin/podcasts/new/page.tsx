import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PodcastCreateForm } from "@/components/podcast-create-form";
import { actorForPage } from "@/lib/session";
import { getPodcastFormOptions } from "@/modules/podcasts/service";

export default async function NewPodcastPage() {
  const actor = await actorForPage(await headers()); if (actor.role === "VIEWER") redirect("/admin/podcasts"); const options = await getPodcastFormOptions(actor);
  return <><Link className="back-link" href="/admin/podcasts">← Podcasts</Link><section className="page-heading"><div><div className="eyebrow">New draft</div><h1>Create Podcast</h1><p className="muted">A stable shared Track/Podcast legacy ID is allocated immediately.</p></div></section><PodcastCreateForm artists={options.artists.map(({ id, name, legacyId }) => ({ id, name, legacyId }))} labels={options.labels} /></>;
}
