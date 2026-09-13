import { log } from "./logger";

/** Opt-in, numeric-only diagnostics for the isolated regression test. */
export function revealTiming(event: string) {
  const enabled = process.env.CMS_REVEAL_TIMING === "1";
  const start = performance.now();
  const marks: Record<string, number> = {};
  return {
    mark(name: string) {
      if (enabled) marks[name] = Math.round((performance.now() - start) * 100) / 100;
    },
    finish() {
      if (enabled) log("info", event, { ...marks, totalMs: Math.round((performance.now() - start) * 100) / 100 });
      return enabled;
    },
  };
}
