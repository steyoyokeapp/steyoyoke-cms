import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "./logger";
export const readMetrics = new AsyncLocalStorage<{
  queries: number;
  poolWaitCount: number;
}>();
const last = new Map<string, number>();
export async function measureRead<T>(
  service: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const metrics = { queries: 0, poolWaitCount: 0 };
  return readMetrics.run(metrics, async () => {
    const result = await fn();
    if (Date.now() - (last.get(service) ?? 0) > 60_000) {
      last.set(service, Date.now());
      log("info", "cms_read", {
        service,
        durationMs: Math.round(performance.now() - started),
        queryCount: metrics.queries,
        poolWaitCount: metrics.poolWaitCount,
        bytes: Buffer.byteLength(JSON.stringify(result)),
      });
    }
    return result;
  });
}
