import Link from "next/link";
import {headers} from "next/headers";
import {actorForPage} from "@/lib/session";
import {trackEditor} from "@/modules/catalogue/editor";
import {TrackEditor} from "@/components/track-editor";
import {safeReturnTo} from "@/modules/catalogue/browse";
export default async function Page({params,searchParams}:PageProps<"/admin/tracks/[id]">) {
 const actor=await actorForPage(await headers());const data=await trackEditor(actor,(await params).id);
 return <><Link className="back-link" href={safeReturnTo((await searchParams).returnTo,"tracks")}>← Tracks</Link><section className="page-heading"><div><div className="eyebrow">Track record</div><h1>{data.track.title}</h1><p className="muted">Working draft and immutable delivery snapshots.</p></div></section><TrackEditor {...data} role={actor.role} /></>;
}
