import { describe, expect, it } from "vitest";
import { formatCmsDate } from "@/lib/date";

describe("CMS date formatting", () => {
  it("uses a stable locale and UTC date on server and client inputs", () => {
    expect(formatCmsDate("2026-09-11T23:30:00-07:00")).toBe("Sep 12, 2026");
    expect(formatCmsDate(new Date("2026-09-11T12:00:00Z"))).toBe("Sep 11, 2026");
  });
});
