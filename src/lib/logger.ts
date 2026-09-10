type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, string | number | boolean | null | undefined>;

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const candidate = process.env.LOG_LEVEL as LogLevel | undefined;
  return candidate && candidate in order ? candidate : "info";
}

export function log(level: LogLevel, event: string, fields: LogFields = {}) {
  if (order[level] < order[configuredLevel()]) return;
  const record = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(record);
  else console.log(record);
}
