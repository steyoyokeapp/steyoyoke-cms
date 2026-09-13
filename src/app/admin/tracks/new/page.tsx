import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { TrackCreateForm } from "@/components/track-create-form";
import { actorForPage } from "@/lib/session";
import {filterOptions} from "@/modules/catalogue/reads";

export default async function NewTrackPage() {
  const actor = await actorForPage(await headers()); if (actor.role === "VIEWER") redirect("/admin/tracks");
  const options = await filterOptions(actor);
  return <><Link className="back-link" href="/admin/tracks">← Tracks</Link><section className="page-heading"><div><div className="eyebrow">New draft</div><h1>Create Track</h1><p className="muted">A stable legacy ID is allocated immediately.</p></div></section><TrackCreateForm artists={options.artists.map(({ id, name, legacyId }) => ({ id, name, legacyId }))} labels={options.labels} /></>;
}
