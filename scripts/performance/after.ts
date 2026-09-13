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
const client = new PrismaClient({
  adapter: new PrismaPg(pool),
  log: [{ emit: "event", level: "query" }],
});
let queries = 0,
  sqlMs = 0;
const stages: Array<{ ms: number; category: string }> = [];
client.$on("query", (e) => {
  queries++;
  sqlMs += e.duration;
  stages.push({
    ms: e.duration,
    category: e.query.includes("COUNT(")
      ? "counts"
      : e.query.includes("media_variants")
        ? "variants"
        : e.query.includes("media_assets")
          ? "page/media"
          : "relations",
  });
});
Object.assign(globalThis, { databaseRuntime: { pool, prisma: client } });
const l = await import("../../src/modules/catalogue/reads");
const d = await import("../../src/modules/catalogue/editor");
const m = await import("../../src/modules/media/service");
const actor = { userId: "benchmark-readonly", role: "ADMIN" as const };
const cases: Record<string, () => Promise<unknown>> = {
  "Artists list": () => l.cataloguePage(actor, "artists"),
  "Artist detail": () =>
    d.artistEditor(actor, "bf82ebc6-ada9-59c9-9273-dc633d2c9fa5"),
  "Tracks list": () =>
    Promise.all([l.cataloguePage(actor, "tracks"), l.filterOptions(actor)]),
  "Track detail": () =>
    d.trackEditor(actor, "7b2ec38d-f035-5b58-88e7-2a994ba8b94a"),
  "Podcasts list": () =>
    Promise.all([l.cataloguePage(actor, "podcasts"), l.filterOptions(actor)]),
  "Podcast detail": () =>
    d.podcastEditor(actor, "e9ccdb68-d0a3-54bd-a3bf-fabbe06085f3"),
  "Releases list": () =>
    Promise.all([l.cataloguePage(actor, "releases"), l.filterOptions(actor)]),
  "Release detail": () =>
    d.releaseEditor(actor, "930644fd-898d-58ec-b8d6-3f01e0b46819"),
  Media: () => m.listMediaAssets(actor),
};
process.env.LOG_LEVEL = "error";
await pool.query("SELECT 1");
for (const [page, fn] of Object.entries(cases)) {
  for (let sample = 0; sample < 3; sample++) {
    queries = 0;
    sqlMs = 0;
    stages.length = 0;
    const start = performance.now();
    const data = await fn();
    console.log(
      JSON.stringify({
        page,
        sample,
        queries,
        serviceMs: Math.round(performance.now() - start),
        sqlMs,
        bytes: Buffer.byteLength(JSON.stringify(data)),
        ...(page === "Media" ? { stages } : {}),
      }),
    );
  }
}
await client.$disconnect();
await pool.end();
