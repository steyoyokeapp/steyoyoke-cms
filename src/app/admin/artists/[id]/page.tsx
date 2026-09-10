import Link from "next/link";
import { headers } from "next/headers";
import { actorForPage } from "@/lib/session";
import { getArtist } from "@/modules/artists/service";
import { ArtistEditor, type ArtistEditorData } from "@/components/artist-editor";

export default async function ArtistPage({ params }: PageProps<"/admin/artists/[id]">) {
  const actor = await actorForPage(await headers());
  const { id } = await params;
  const artist = await getArtist(actor, id);
  const data: ArtistEditorData = {
    id: artist.id, legacyId: artist.legacyId, name: artist.name, slug: artist.slug,
    shortBio: artist.shortBio, facebookUrl: artist.facebookUrl, status: artist.status,
    workingVersion: artist.workingVersion, scheduledFor: artist.scheduledFor?.toISOString() ?? null,
    publishedRevision: artist.publishedRevision ? { ...artist.publishedRevision, createdAt: artist.publishedRevision.createdAt.toISOString() } : null,
    scheduledRevision: artist.scheduledRevision ? { ...artist.scheduledRevision, createdAt: artist.scheduledRevision.createdAt.toISOString() } : null,
    revisions: artist.revisions.map((revision) => ({ ...revision, createdAt: revision.createdAt.toISOString() })),
    auditLogs: artist.auditLogs.map((log) => ({ id: log.id, action: log.action, createdAt: log.createdAt.toISOString(), actor: log.actor ? { name: log.actor.name } : null })),
  };
  return (
    <>
      <Link className="back-link" href="/admin/artists">← Artists</Link>
      <section className="page-heading"><div><div className="eyebrow">Artist record</div><h1>{artist.name}</h1><p className="muted">Working draft and immutable delivery snapshots.</p></div></section>
      <ArtistEditor artist={data} role={actor.role} />
    </>
  );
}
