/** Run before changes: npx tsx scripts/performance/baseline.ts. Numeric output only. */
import fs from "node:fs";
import dotenv from "dotenv";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
dotenv.config({ path: ".env", quiet: true });
const url = dotenv.parse(
  fs.readFileSync(".env.local"),
).PRODUCTION_READONLY_DATABASE_URL;
if (!url || new URL(url).username !== "steyoyoke_inventory_ro")
  throw new Error("Dedicated read-only role required");
const pool = new Pool({ connectionString: url, max: 3 });
const check = await pool.query("SELECT current_user AS role");
if (check.rows[0].role !== "steyoyoke_inventory_ro")
  throw new Error("Wrong role");
const client = new PrismaClient({
  adapter: new PrismaPg(pool),
  log: [{ emit: "event", level: "query" }],
});
let count = 0;
let sqlMs = 0;
client.$on("query", (e) => {
  count++;
  sqlMs += e.duration;
});
Object.assign(globalThis, { databaseRuntime: { pool, prisma: client } });
const a = await import("../../src/modules/artists/service");
const t = await import("../../src/modules/tracks/service");
const p = await import("../../src/modules/podcasts/service");
const r = await import("../../src/modules/releases/service");
const m = await import("../../src/modules/media/service");
const actor = { userId: "benchmark-readonly", role: "ADMIN" as const };
const ids = [
  "bf82ebc6-ada9-59c9-9273-dc633d2c9fa5",
  "7b2ec38d-f035-5b58-88e7-2a994ba8b94a",
  "e9ccdb68-d0a3-54bd-a3bf-fabbe06085f3",
  "930644fd-898d-58ec-b8d6-3f01e0b46819",
] as const;
const cases: Record<string, () => Promise<unknown>> = {
  "Artists list": () => a.listArtists(actor),
  "Artist detail": async () => {
    const x = await a.getArtist(actor, ids[0]);
    return {
      record: x,
      media: await m.listMediaOptions(actor, "IMAGE", x.imageAssetId),
    };
  },
  "Tracks list": async () =>
    Promise.all([t.listTracks(actor), t.getTrackFormOptions(actor)]),
  "Track detail": async () => {
    const x = await t.getTrack(actor, ids[1]);
    return {
      record: x,
      options: await t.getTrackFormOptions(actor, x),
      media: await m.listMediaOptions(actor, "IMAGE", x.artworkAssetId),
      audio: await m.listMediaOptions(actor, "AUDIO", x.audioAssetId),
    };
  },
  "Podcasts list": async () =>
    Promise.all([p.listPodcasts(actor), p.getPodcastFormOptions(actor)]),
  "Podcast detail": async () => {
    const x = await p.getPodcast(actor, ids[2]);
    return {
      record: x,
      options: await p.getPodcastFormOptions(actor, x),
      media: await m.listMediaOptions(actor, "IMAGE", x.artworkAssetId),
      audio: await m.listMediaOptions(actor, "AUDIO", x.audioAssetId),
    };
  },
  "Releases list": async () =>
    Promise.all([r.listReleases(actor), r.getReleaseFormOptions(actor)]),
  "Release detail": async () => {
    const x = await r.getRelease(actor, ids[3]);
    return {
      record: x,
      options: await r.getReleaseFormOptions(actor, {
        ...x,
        trackIds: x.tracks.map((t) => t.trackId),
      }),
      media: await m.listMediaOptions(actor, "IMAGE", x.artworkAssetId),
    };
  },
  Media: () => m.listMediaAssets(actor),
};
await pool.query("SELECT 1");
for (const [page, fn] of Object.entries(cases)) {
  for (let sample = 0; sample < 3; sample++) {
    count = 0;
    sqlMs = 0;
    const start = performance.now();
    const data = await fn();
    console.log(
      JSON.stringify({
        page,
        sample,
        queries: count,
        serviceMs: Math.round(performance.now() - start),
        sqlMs,
        bytes: Buffer.byteLength(JSON.stringify(data)),
      }),
    );
  }
}
await client.$disconnect();
await pool.end();
