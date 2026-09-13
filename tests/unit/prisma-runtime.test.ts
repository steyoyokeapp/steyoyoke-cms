import { afterEach, expect, it, vi } from "vitest";
const counters = vi.hoisted(() => ({ pools: vi.fn(), clients: vi.fn(), adapters: vi.fn(), attach: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { DATABASE_URL: "postgresql://unchanged" } }));
vi.mock("@/lib/database-pool", () => ({ DatabasePool: class { constructor(url: string) { counters.pools(url); } } }));
vi.mock("@/generated/prisma/client", () => ({ PrismaClient: class { constructor(config: unknown) { counters.clients(config); } } }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class { constructor(...args: unknown[]) { counters.adapters(...args); } } }));
vi.mock("@vercel/functions", () => ({ attachDatabasePool: counters.attach }));
const runtimeGlobal = globalThis as unknown as { databaseRuntime?: unknown };
afterEach(() => { delete runtimeGlobal.databaseRuntime; vi.unstubAllEnvs(); vi.clearAllMocks(); vi.resetModules(); });

it.each(["development", "production"])("reuses one pool/client across module evaluation in %s", async (mode) => {
  vi.stubEnv("NODE_ENV", mode); vi.stubEnv("VERCEL", "1"); delete runtimeGlobal.databaseRuntime;
  const first = await import("@/lib/prisma"); vi.resetModules(); const second = await import("@/lib/prisma");
  expect(second.prisma).toBe(first.prisma); expect(counters.pools).toHaveBeenCalledExactlyOnceWith("postgresql://unchanged");
  expect(counters.clients).toHaveBeenCalledTimes(1); expect(counters.attach).toHaveBeenCalledTimes(1);
  expect(counters.adapters).toHaveBeenCalledWith(counters.attach.mock.calls[0]![0], { disposeExternalPool: true });
});
it("does not attach Vercel lifecycle handlers outside Vercel", async () => {
  vi.stubEnv("VERCEL", ""); await import("@/lib/prisma"); expect(counters.attach).not.toHaveBeenCalled();
});
