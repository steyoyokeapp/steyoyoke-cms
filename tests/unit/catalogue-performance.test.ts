import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  artist: { findMany: vi.fn() },
  track: { findMany: vi.fn() },
  podcastEpisode: { findMany: vi.fn() },
  release: { findMany: vi.fn() },
  label: { findMany: vi.fn() },
  mediaAsset: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { cataloguePage, listSelect } from "@/modules/catalogue/reads";
import { editorSelect } from "@/modules/catalogue/editor";
import { searchChoices } from "@/modules/catalogue/pickers";
import { browseSchema, safeReturnTo } from "@/modules/catalogue/browse";
const actor = { userId: "test", role: "VIEWER" as const };
beforeEach(() => {
  vi.clearAllMocks();
  for (const d of Object.values(db)) d.findMany.mockResolvedValue([]);
});
describe("catalogue architectural budgets", () => {
  for (const [kind, delegate] of [
    ["artists", "artist"],
    ["tracks", "track"],
    ["podcasts", "podcastEpisode"],
    ["releases", "release"],
  ] as const) {
    it(`${kind} pages in SQL, returns 50, has stable ties, excludes editor graphs`, async () => {
      db[delegate].findMany.mockResolvedValue(
        Array.from({ length: 51 }, (_, i) => ({ id: String(i) })),
      );
      const page = await cataloguePage(actor, kind, { page: 3, q: "Impulse" });
      expect(page.items).toHaveLength(50);
      expect(page.hasMore).toBe(true);
      expect(db[delegate].findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 100,
          take: 51,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: listSelect[kind],
        }),
      );
      expect(db.label.findMany).not.toHaveBeenCalled();
      if (kind !== "tracks") expect(db.track.findMany).not.toHaveBeenCalled();
      for (const key of [
        "revisions",
        "auditLogs",
        "variants",
        "audioAsset",
        "artworkAsset",
      ])
        expect(listSelect[kind]).not.toHaveProperty(key);
    });
    it(`${kind} initial editor has no history or eager option dataset`, () => {
      expect(editorSelect[kind]).not.toHaveProperty("revisions");
      expect(editorSelect[kind]).not.toHaveProperty("auditLogs");
    });
  }
  it("keeps artist+label+status+search together", async () => {
    const artistId = "bf82ebc6-ada9-59c9-9273-dc633d2c9fa5";
    await cataloguePage(actor, "tracks", {
      artistId,
      labelId: artistId,
      status: "DRAFT",
      q: "x",
    });
    expect(db.track.findMany.mock.calls[0]![0].where).toEqual({
      status: "DRAFT",
      labelId: artistId,
      title: { contains: "x", mode: "insensitive" },
      OR: [{ primaryArtistId: artistId }, { secondaryArtistId: artistId }],
    });
  });
  for (const kind of ["artist", "artist-filter", "track", "IMAGE", "AUDIO"])
    it(`${kind} choice search is capped at 25`, async () => {
      await searchChoices(actor, { kind, q: "test" });
      const delegate = kind.startsWith("artist")
        ? db.artist
        : kind === "track"
          ? db.track
          : db.mediaAsset;
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 25 }),
      );
    });
  it("never offers EXTERNAL or RETIRED audio as a new attachment", async () => {
    await searchChoices(actor, { kind: "AUDIO" });
    expect(db.mediaAsset.findMany.mock.calls[0]![0].where).toEqual({
      kind: "AUDIO",
      status: "READY",
    });
  });
  it("normalizes invalid pages and rejects unsafe filter values", () => {
    expect(browseSchema.parse({ page: -2 }).page).toBe(1);
    expect(() => browseSchema.parse({ status: "wrong" })).toThrow();
    expect(() => browseSchema.parse({ artistId: "bad" })).toThrow();
  });
  it("does not turn list return state into an open redirect", () => {
    expect(safeReturnTo("https://evil.test", "tracks")).toBe("/admin/tracks");
    expect(safeReturnTo("//evil.test", "tracks")).toBe("/admin/tracks");
    expect(safeReturnTo("/admin/tracks?page=2&q=x", "tracks")).toBe(
      "/admin/tracks?page=2&q=x",
    );
  });
});
