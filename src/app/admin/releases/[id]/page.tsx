import Link from "next/link";
import {headers} from "next/headers";
import {actorForPage} from "@/lib/session";
import {releaseEditor} from "@/modules/catalogue/editor";
import {ReleaseEditor} from "@/components/release-editor";
import {safeReturnTo} from "@/modules/catalogue/browse";
export default async function Page({params,searchParams}:PageProps<"/admin/releases/[id]">) {
 const actor=await actorForPage(await headers());const data=await releaseEditor(actor,(await params).id);
 return <><Link className="back-link" href={safeReturnTo((await searchParams).returnTo,"releases")}>← Releases</Link><section className="page-heading"><div><div className="eyebrow">Release record</div><h1>{data.release.title}</h1><p className="muted">Working draft and immutable delivery snapshots.</p></div></section><ReleaseEditor {...data} role={actor.role} /></>;
}
