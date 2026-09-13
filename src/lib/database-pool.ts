import {readMetrics} from "./read-performance";
import { Pool, type PoolClient } from "pg";
import { log } from "@/lib/logger";

export const DATABASE_POOL_LIMITS = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
};

type ConnectCallback = (error: Error | undefined, client: PoolClient | undefined, release: (error?: Error | boolean) => void) => void;

// Observe pool acquisition, including Pool.query's callback path. Never serialize errors,
// client objects, connection options, SQL, or request context into pool diagnostics.
export class DatabasePool extends Pool {
  private acquisitionFailures = 0;
  private acquisitionTimeouts = 0;
  private idleClientErrors = 0;
  private lastSnapshot = -Infinity;
  private lastFailureSnapshot = -Infinity;

  constructor(connectionString: string) {
    super({ connectionString, ...DATABASE_POOL_LIMITS });
    this.on("connect", client => {
      client.query = new Proxy(client.query, {apply(target, self, args) {
        const metrics=readMetrics.getStore();if(metrics)metrics.queries++;
        return Reflect.apply(target,self,args);
      }});
    });
    this.on("acquire", () => this.report(false));
    this.on("error", () => { this.idleClientErrors += 1; this.report(true); });
  }

  private report(failed: boolean) {
    const now = Date.now();
    const previous = failed ? this.lastFailureSnapshot : this.lastSnapshot;
    if (now - previous < 60_000) return;
    if (failed) this.lastFailureSnapshot = now; else this.lastSnapshot = now;
    log(failed ? "warn" : "info", "database_pool", {
      totalCount: this.totalCount, idleCount: this.idleCount, waitingCount: this.waitingCount,
      acquisitionFailures: this.acquisitionFailures, acquisitionTimeouts: this.acquisitionTimeouts,
      idleClientErrors: this.idleClientErrors,
    });
  }

  private acquisitionFailed(error: Error) {
    this.acquisitionFailures += 1;
    if (error.message === "timeout exceeded when trying to connect" || error.message.startsWith("Connection terminated due to connection timeout")) this.acquisitionTimeouts += 1;
    this.report(true);
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const metrics=readMetrics.getStore();
    if(metrics && this.idleCount===0 && this.totalCount>=DATABASE_POOL_LIMITS.max)metrics.poolWaitCount++;
    if (callback) {
      return super.connect((error, client, release) => {
        if (error) this.acquisitionFailed(error);
        callback(error, client, release);
      });
    }
    return super.connect().catch((error: Error) => { this.acquisitionFailed(error); throw error; });
  }
}
