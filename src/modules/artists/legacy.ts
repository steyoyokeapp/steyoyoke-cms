import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import {
  getPublishedArtistForLegacy,
  listPublishedArtistsForLegacy,
} from "@/modules/artists/service";
import { LegacyMediaSerializer } from "@/modules/media/legacy";

type LegacySource = Awaited<ReturnType<typeof listPublishedArtistsForLegacy>>[number];

export function serializeLegacyArtist(artist: LegacySource) {
  const revision = artist.publishedRevision;
  if (!revision) throw new Error("Published artist is missing its revision.");
  return {
    id: String(artist.legacyId),
    name: revision.name,
    image: LegacyMediaSerializer.path(revision.imageAsset, "LEGACY_1440"),
    facebook_url: revision.facebookUrl,
    description_short: revision.shortBio,
    priority: null,
  };
}

export function legacyArtistEnvelope(artists: LegacySource[]) {
  return {
    artists: artists.map(serializeLegacyArtist),
    base_cover_folder: "/1440/",
    main_cover_folder: "/assets/uploads/files",
  };
}

export function isLegacyAuthorized(request: Request): boolean {
  const token = request.headers.get("x-csrf-token");
  if (!token) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const presented = digest(token);
  return [env.LEGACY_API_KEY_A, env.LEGACY_API_KEY_B]
    .some((expected) => timingSafeEqual(presented, digest(expected)));
}

export function legacyUnauthorized() {
  return new Response("<!doctype html><html><head><title>Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>", {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function handleLegacyArtistRequest(request: Request, legacyId?: number) {
  if (!isLegacyAuthorized(request)) return legacyUnauthorized();
  if (new URL(request.url).searchParams.get("filter") !== "artists") {
    return Response.json({ error: "Unsupported filter." }, { status: 400 });
  }
  const artists = legacyId === undefined
    ? await listPublishedArtistsForLegacy()
    : await getPublishedArtistForLegacy(legacyId).then((artist) => artist ? [artist] : []);
  return Response.json(legacyArtistEnvelope(artists), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
