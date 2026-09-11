import { describe, expect, it } from "vitest";
import { assertLocalCmsDatabase } from "../../scripts/local-database";
import { localE2EMarkers } from "@/lib/dev-cleanup";

describe("local E2E cleanup safety", () => {
  it("matches only exact markers emitted by Playwright", () => {
    const stamp = "1789123456789";
    expect(localE2EMarkers.artist(`E2E Draft ${stamp}`)).toBe(true);
    expect(localE2EMarkers.artist(`Audio E2E Artist ${stamp}`)).toBe(true);
    expect(localE2EMarkers.track(`Release Track A ${stamp} r2`)).toBe(true);
    expect(localE2EMarkers.podcast(`Podcast E2E Updated ${stamp}`)).toBe(true);
    expect(localE2EMarkers.release(`Steyoyoke Release E2E ${stamp}`)).toBe(true);
    expect(localE2EMarkers.media(`podcast-${stamp}.mp3`)).toBe(true);
    expect(localE2EMarkers.artist("Media E2E Artist Manual")).toBe(false);
    expect(localE2EMarkers.track("A legitimate E2E-inspired title")).toBe(false);
    expect(localE2EMarkers.media("podcast-final.mp3")).toBe(false);
  });

  it("refuses remote, staging, production, and non-dedicated local databases", () => {
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@localhost:5432/steyoyoke_cms_local", "Local E2E cleanup")).not.toThrow();
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@localhost:5432/steyoyoke_cms_staging", "Local E2E cleanup")).toThrow(/restricted/);
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@localhost:5432/steyoyoke_cms_test", "Local E2E cleanup")).toThrow(/restricted/);
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@ep-example.neon.tech/steyoyoke", "Local E2E cleanup")).toThrow(/restricted/);
  });
});
