import { afterEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { DatabasePool } from "@/lib/database-pool";
import { log } from "@/lib/logger";

vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("database pool configuration and diagnostics", () => {
  it("keeps concurrency/acquisition limits and reduces idle retention", async () => {
    const pool = new DatabasePool("postgresql://user:secret@localhost/test");
    expect(pool.options).toMatchObject({ max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    expect(pool.totalCount).toBe(0); await pool.end();
  });

  it("counts callback and promise failures, rate limits snapshots, and never logs secrets", async () => {
    let now = 0; vi.spyOn(Date, "now").mockImplementation(() => now);
    const pool = new DatabasePool("postgresql://user:password@private-host/test");
    const failure = new Error("timeout exceeded when trying to connect");
    const nativeConnect = vi.spyOn(Pool.prototype, "connect");
    nativeConnect.mockImplementation(((callback?: (error: Error) => void) => callback ? callback(failure) : Promise.reject(failure)) as typeof Pool.prototype.connect);
    for (let i = 0; i < 3; i++) await expect(pool.connect()).rejects.toBe(failure);
    await new Promise<void>((resolve) => pool.connect((error) => { expect(error).toBe(failure); resolve(); }));
    expect(log).toHaveBeenCalledTimes(1);
    now = 60_001;
    pool.emit("error", new Error("password=leaked DATABASE_URL=postgresql://user:password@private-host/test token=secret"), {} as PoolClient);
    expect(log).toHaveBeenLastCalledWith("warn", "database_pool", {
      totalCount: 0, idleCount: 0, waitingCount: 0, acquisitionFailures: 4, acquisitionTimeouts: 4, idleClientErrors: 1,
    });
    pool.emit("acquire", {} as PoolClient); pool.emit("acquire", {} as PoolClient);
    expect(log).toHaveBeenCalledTimes(3);
    const serialized = JSON.stringify(vi.mocked(log).mock.calls);
    for (const secret of ["password", "private-host", "postgresql", "token", "secret"]) expect(serialized).not.toContain(secret);
    await pool.end();
  });

  it("passes successful callback acquisition through without changing release", async () => {
    const pool = new DatabasePool("postgresql://localhost/test"); const client = {} as PoolClient; const release = vi.fn();
    vi.spyOn(Pool.prototype, "connect").mockImplementation(((callback: (error: undefined, client: PoolClient, release: () => void) => void) => callback(undefined, client, release)) as typeof Pool.prototype.connect);
    const callback = vi.fn(); pool.connect(callback); expect(callback).toHaveBeenCalledWith(undefined, client, release);
    await pool.end();
  });
});

it("counts numeric SQL dispatches in their own read scope without retaining SQL", async()=>{
 const {readMetrics}=await import("@/lib/read-performance");const pool=new DatabasePool("postgresql://localhost/test");
 const query=vi.fn().mockResolvedValue({rows:[]});const client={query} as unknown as PoolClient;pool.emit("connect",client);
 const one={queries:0,poolWaitCount:0},two={queries:0,poolWaitCount:0};
 await Promise.all([readMetrics.run(one,async()=>{await client.query("SELECT 1");await client.query("SELECT 2");}),readMetrics.run(two,async()=>{await client.query("SELECT 3");})]);
 expect(one.queries).toBe(2);expect(two.queries).toBe(1);expect(Object.keys(one)).toEqual(["queries","poolWaitCount"]);await pool.end();
});
