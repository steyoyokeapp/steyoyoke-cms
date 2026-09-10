import Link from "next/link";
import { headers } from "next/headers";
import { TrackEditor, type TrackEditorData } from "@/components/track-editor";
import { actorForPage } from "@/lib/session";
import { serializeLegacyTrack } from "@/modules/tracks/legacy";
import { getTrack, getTrackFormOptions } from "@/modules/tracks/service";

export default async function TrackPage({ params }: PageProps<"/admin/tracks/[id]">) {
  const actor = await actorForPage(await headers()); const track = await getTrack(actor, (await params).id); const options = await getTrackFormOptions(actor, track);
  const revision = track.publishedRevision;
  const data: TrackEditorData = {
    id: track.id, legacyId: track.legacyId, title: track.title, primaryArtistId: track.primaryArtistId, secondaryArtistId: track.secondaryArtistId, labelId: track.labelId, durationMs: track.durationMs,
    spotifyUrl: track.spotifyUrl, beatportUrl: track.beatportUrl, traxsourceUrl: track.traxsourceUrl, bandcampUrl: track.bandcampUrl, appleMusicUrl: track.appleMusicUrl, soundcloudUrl: track.soundcloudUrl,
    status: track.status, workingVersion: track.workingVersion, scheduledFor: track.scheduledFor?.toISOString() ?? null,
    publishedRevision: revision ? { id: revision.id, revisionNumber: revision.revisionNumber, sourceWorkingVersion: revision.sourceWorkingVersion, title: revision.title, primaryArtistName: revision.primaryArtistName, labelName: revision.labelName, createdAt: revision.createdAt.toISOString() } : null,
    scheduledRevision: track.scheduledRevision ? { id: track.scheduledRevision.id, revisionNumber: track.scheduledRevision.revisionNumber, sourceWorkingVersion: track.scheduledRevision.sourceWorkingVersion, title: track.scheduledRevision.title, primaryArtistName: track.scheduledRevision.primaryArtistName, labelName: track.scheduledRevision.labelName, createdAt: track.scheduledRevision.createdAt.toISOString() } : null,
    revisions: track.revisions.map((item) => ({ id: item.id, revisionNumber: item.revisionNumber, sourceWorkingVersion: item.sourceWorkingVersion, title: item.title, primaryArtistName: item.primaryArtistName, labelName: item.labelName, createdAt: item.createdAt.toISOString() })),
    auditLogs: track.auditLogs.map((item) => ({ id: item.id, action: item.action, createdAt: item.createdAt.toISOString(), actor: item.actor ? { name: item.actor.name } : null })),
  };
  const legacyPreview = revision && (track.status === "PUBLISHED" || track.status === "SCHEDULED") ? { tracks: [serializeLegacyTrack(revision, track.legacyId)], base_cover_folder: "/1440/", main_cover_folder: "/assets/uploads/files" } : null;
  return <><Link className="back-link" href="/admin/tracks">← Tracks</Link><section className="page-heading"><div><div className="eyebrow">Track record</div><h1>{track.title}</h1><p className="muted">Working draft and immutable delivery snapshots.</p></div></section><TrackEditor track={data} role={actor.role} artists={options.artists.map(({ id, name, legacyId }) => ({ id, name, legacyId }))} labels={options.labels.map(({ id, name, active }) => ({ id, name, active }))} legacyPreview={legacyPreview} /></>;
}
