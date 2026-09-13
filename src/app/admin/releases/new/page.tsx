import Link from "next/link";
import { headers } from "next/headers";
import { ReleaseCreateForm } from "@/components/release-create-form";
import { actorForPage } from "@/lib/session";
import {filterOptions} from "@/modules/catalogue/reads";

export default async function NewReleasePage() {
  const actor = await actorForPage(await headers()); const options = await filterOptions(actor);
  return <><Link className="back-link" href="/admin/releases">← Releases</Link><section className="page-heading"><div><div className="eyebrow">New record</div><h1>Create Release</h1><p className="muted">A stable legacy Release ID is allocated immediately.</p></div></section><ReleaseCreateForm artists={options.artists.map(({ id, name, legacyId }) => ({ id, name, legacyId }))} labels={options.labels.map(({ id, name }) => ({ id, name }))} /></>;
}
