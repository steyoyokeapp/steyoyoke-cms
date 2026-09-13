import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { actorForPage } from "@/lib/session";
import { ArtistCreateForm } from "@/components/artist-create-form";

export default async function NewArtistPage() {
  const actor = await actorForPage(await headers());
  if (actor.role === "VIEWER") redirect("/admin/artists");
  return (
    <>
      <Link className="back-link" href="/admin/artists">← Artists</Link>
      <section className="page-heading"><div><h1>Create artist</h1></div></section>
      <ArtistCreateForm />
    </>
  );
}
