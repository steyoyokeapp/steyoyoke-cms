import { expect, it } from "vitest";
import { mediaBrowseQuery, parseMediaBrowse } from "@/modules/media/browse";

it("round trips URL view/kind/page and normalizes invalid inputs", () => {
  for (const view of ["ACTIVE", "RETIRED"] as const) for (const kind of ["ALL", "IMAGE", "AUDIO"] as const) {
    const browse = { view, kind, page: 3 }; expect(parseMediaBrowse(mediaBrowseQuery(browse))).toEqual(browse);
  }
  for (const page of ["0", "-1", "NaN", "Infinity", "1.5", "1e100"]) expect(parseMediaBrowse(new URLSearchParams({ page, view: "bad", kind: "bad" }))).toEqual({ view: "ACTIVE", kind: "ALL", page: 1 });
  expect(mediaBrowseQuery({ view: "ACTIVE", kind: "ALL", page: 1 }).toString()).toBe("");
});
