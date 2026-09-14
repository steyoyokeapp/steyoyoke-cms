import Link from "next/link";
import {headers} from "next/headers";
import {actorForPage} from "@/lib/session";
import {podcastEditor} from "@/modules/catalogue/editor";
import {PodcastEditor} from "@/components/podcast-editor";
import {safeReturnTo} from "@/modules/catalogue/browse";
export default async function Page({params,searchParams}:PageProps<"/admin/podcasts/[id]">) {
 const actor=await actorForPage(await headers());const data=await podcastEditor(actor,(await params).id);
 return <><Link className="back-link" href={safeReturnTo((await searchParams).returnTo,"podcasts")}>← Podcasts</Link><section className="page-heading"><div><div className="eyebrow">Podcast record</div><h1>{data.podcast.title}</h1><p className="muted">Manage audio, episode details and chapters.</p></div></section><PodcastEditor {...data} role={actor.role} /></>;
}
