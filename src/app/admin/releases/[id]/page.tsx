import { revealTiming } from "@/lib/reveal-timing";
import { RevealProbe } from "@/components/reveal-probe";
import Link from "next/link";
import {headers} from "next/headers";
import {actorForPage} from "@/lib/session";
import {releaseEditor} from "@/modules/catalogue/editor";
import {ReleaseEditor} from "@/components/release-editor";
import {safeReturnTo} from "@/modules/catalogue/browse";
export default async function Page({params,searchParams}:PageProps<"/admin/releases/[id]">) {
 const timing = revealTiming("cms_release_page");
 const actor=await actorForPage(await headers());timing.mark("sessionCompleteMs");
 timing.mark("serviceStartMs");const data=await releaseEditor(actor,(await params).id);
 timing.mark("serviceEndMs");
 const content = <><Link className="back-link" href={safeReturnTo((await searchParams).returnTo,"releases")}>← Releases</Link><section className="page-heading"><div><div className="eyebrow">Release record</div><h1>{data.release.title}</h1><p className="muted">Working draft and immutable delivery snapshots.</p></div></section><ReleaseEditor {...data} role={actor.role} />{process.env.CMS_REVEAL_TIMING === "1" && <RevealProbe kind="release" />}</>;
 timing.mark("constructedMs");timing.finish();return content;
}
