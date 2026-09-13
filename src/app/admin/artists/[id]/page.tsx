import Link from "next/link";
import {headers} from "next/headers";
import {actorForPage} from "@/lib/session";
import {artistEditor} from "@/modules/catalogue/editor";
import {ArtistEditor} from "@/components/artist-editor";
import {safeReturnTo} from "@/modules/catalogue/browse";
export default async function Page({params,searchParams}:PageProps<"/admin/artists/[id]">) {
 const actor=await actorForPage(await headers());const data=await artistEditor(actor,(await params).id);
 return <><Link className="back-link" href={safeReturnTo((await searchParams).returnTo,"artists")}>← Artists</Link><section className="page-heading"><div><h1>Artist</h1></div></section><ArtistEditor {...data} role={actor.role} /></>;
}
