import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET as live } from "@/app/health/live/route";
import { GET as ready } from "@/app/health/ready/route";
import { POST as publishScheduled } from "@/app/api/internal/publish-scheduled/route";

describe("staging operational endpoints", () => {
  afterAll(async () => prisma.$disconnect());

  it("reports liveness without exposing environment details", async () => {
    const response = live();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "live" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports database readiness with a cheap query", async () => {
    const response = await ready();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", database: "reachable" });
  });

  it("keeps the scheduled publisher disabled by default", async () => {
    const before = process.env.SCHEDULED_PUBLISHER_ENABLED;
    process.env.SCHEDULED_PUBLISHER_ENABLED = "false";
    try {
      const response = await publishScheduled(new Request("http://local/api/internal/publish-scheduled", { method: "POST" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "SCHEDULER_DISABLED" } });
    } finally {
      if (before === undefined) delete process.env.SCHEDULED_PUBLISHER_ENABLED;
      else process.env.SCHEDULED_PUBLISHER_ENABLED = before;
    }
  });
});
