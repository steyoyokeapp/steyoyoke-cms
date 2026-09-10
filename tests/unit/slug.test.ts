import { describe, expect, it } from "vitest";
import { slugify } from "@/modules/artists/slug";

describe("slugify", () => {
  it("normalizes accents, punctuation, and case", () => {
    expect(slugify("  Âme — Live!  ")).toBe("ame-live");
  });

  it("never returns an empty slug", () => {
    expect(slugify("---")).toBe("artist");
  });
});
