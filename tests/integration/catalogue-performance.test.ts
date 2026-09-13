import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { cataloguePage } from "@/modules/catalogue/reads";
import {
  artistEditor,
  trackEditor,
  podcastEditor,
  releaseEditor,
} from "@/modules/catalogue/editor";
import { searchChoices } from "@/modules/catalogue/pickers";
import { secondaryData } from "@/modules/catalogue/secondary";
import {
  createArtist,
  publishArtist,
  updateArtistDraft,
} from "@/modules/artists/service";
import { createTrack } from "@/modules/tracks/service";
import { createPodcast } from "@/modules/podcasts/service";
import {
  createRelease,
  replaceReleaseTracks,
} from "@/modules/releases/service";
import type { Actor } from "@/lib/authorization";
let actor: Actor;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.endsWith("steyoyoke_cms_test")
  )
    throw new Error("Local test database required");
  const user = await prisma.user.create({
    data: {
      name: "Performance tests",
      email: `performance-${crypto.randomUUID()}@test.local`,
      role: "ADMIN",
    },
  });
  actor = { userId: user.id, role: "ADMIN" };
});
afterAll(() => prisma.$disconnect());
it("paginates tied timestamps in SQL without duplicates and finds a record beyond page one", async () => {
  const prefix = `Perf-${crypto.randomUUID()}`;
  const timestamp = new Date("2030-01-01");
  await prisma.artist.createMany({
    data: Array.from({ length: 123 }, (_, i) => ({
      name: `${prefix}-${String(i).padStart(3, "0")}`,
      slug: `${prefix.toLowerCase()}-${i}`,
      updatedAt: timestamp,
    })),
  });
  const pages = await Promise.all(
    [1, 2, 3].map((page) =>
      cataloguePage(actor, "artists", { page, q: prefix }),
    ),
  );
  expect(pages.map((p) => p.items.length)).toEqual([50, 50, 23]);
  expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
  expect(new Set(pages.flatMap((p) => p.items.map((x) => x.id))).size).toBe(
    123,
  );
  const searched = await searchChoices(actor, {
    kind: "artist-filter",
    q: `${prefix}-122`,
  });
  expect(searched).toHaveLength(1);
});
it("keeps current relationships, chapter order and release membership while omitting histories", async () => {
  const a = await createArtist(actor, {
    name: `Relationship ${crypto.randomUUID()}`,
  });
  await publishArtist(actor, a.id, { expectedWorkingVersion: 1 });
  const label = await prisma.label.create({
    data: {
      name: "Perf label",
      slug: crypto.randomUUID(),
      legacyValue: crypto.randomUUID(),
    },
  });
  const t = await createTrack(actor, {
    title: "Perf track",
    primaryArtistId: a.id,
    labelId: label.id,
  });
  const p = await createPodcast(actor, {
    title: "Perf episode",
    primaryArtistId: a.id,
    labelId: label.id,
  });
  const r = await createRelease(actor, {
    title: "Perf release",
    primaryArtistId: a.id,
    labelId: label.id,
  });
  await replaceReleaseTracks(actor, r.id, {
    trackIds: [t.id],
    expectedWorkingVersion: 1,
  });
  const td = await trackEditor(actor, t.id);
  expect(td.artists.map((x) => x.id)).toEqual([a.id]);
  expect(td.track).not.toHaveProperty("revisions");
  expect(td.audioAssets).toEqual([]);
  expect((await podcastEditor(actor, p.id)).podcast.chapters).toEqual([]);
  const rd = await releaseEditor(actor, r.id);
  expect(rd.release.trackIds).toEqual([t.id]);
  expect(rd.tracks.map((x) => x.id)).toEqual([t.id]);
  expect(Buffer.byteLength(JSON.stringify(rd))).toBeLessThan(10_000);
});
it("bounded history pages preserve older immutable revisions and scoped snapshot access", async () => {
  const a = await createArtist(actor, {
    name: `History ${crypto.randomUUID()}`,
  });
  for (let v = 1; v <= 27; v++) {
    if (v > 1)
      await updateArtistDraft(actor, a.id, {
        name: a.name,
        slug: a.slug,
        shortBio: `version ${v}`,
        facebookUrl: "",
        expectedWorkingVersion: v - 1,
      });
    await publishArtist(actor, a.id, { expectedWorkingVersion: v });
  }
  const initial = await artistEditor(actor, a.id);
  expect(initial.artist.revisionCount).toBe(27);
  expect(initial.artist).not.toHaveProperty("revisions");
  const first = (await secondaryData(actor, {
    kind: "artists",
    id: a.id,
    section: "history",
  })) as { items: { id: string; revisionNumber: number }[]; hasMore: boolean };
  const second = (await secondaryData(actor, {
    kind: "artists",
    id: a.id,
    section: "history",
    page: 2,
  })) as typeof first;
  expect(first.items).toHaveLength(25);
  expect(first.hasMore).toBe(true);
  expect(second.items).toHaveLength(2);
  expect(second.hasMore).toBe(false);
  expect(new Set([...first.items, ...second.items].map((x) => x.id)).size).toBe(
    27,
  );
  const wrong = await createArtist(actor, {
    name: `Wrong ${crypto.randomUUID()}`,
  });
  await expect(
    secondaryData(actor, {
      kind: "artists",
      id: wrong.id,
      section: "snapshot",
      revisionId: first.items[0]!.id,
    }),
  ).rejects.toThrow();
});
