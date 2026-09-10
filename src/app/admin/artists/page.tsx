import Link from "next/link";
import { headers } from "next/headers";
import { actorForPage } from "@/lib/session";
import { listArtists } from "@/modules/artists/service";

export default async function ArtistsPage() {
  const actor = await actorForPage(await headers());
  const artists = await listArtists(actor);
  const canWrite = actor.role !== "VIEWER";
  return (
    <>
      <section className="page-heading">
        <div><div className="eyebrow">Content</div><h1>Artists</h1><p className="muted">Draft safely. Publish deliberately.</p></div>
        {canWrite && <Link className="button primary" href="/admin/artists/new">New artist</Link>}
      </section>
      <section className="panel table-panel">
        <div className="table-row table-head"><span>Artist</span><span>Legacy ID</span><span>Status</span><span>Version</span><span>Updated</span></div>
        {artists.length === 0 && <div className="empty">No artists yet. Create the first draft.</div>}
        {artists.map((artist) => (
          <Link className="table-row" href={`/admin/artists/${artist.id}`} key={artist.id}>
            <span><strong>{artist.name}</strong><small>/{artist.slug}</small></span>
            <span className="mono">{artist.legacyId}</span>
            <span><i className={`status ${artist.status.toLowerCase()}`}>{artist.status}</i></span>
            <span className="mono">v{artist.workingVersion}</span>
            <span>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(artist.updatedAt)}</span>
          </Link>
        ))}
      </section>
    </>
  );
}
