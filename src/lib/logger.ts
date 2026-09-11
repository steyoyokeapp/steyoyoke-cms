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

const SENSITIVE_ENV_NAME = /(secret|token|password|cookie|authorization|database_url|access_key|private_key)/i;

function redact(value: string) {
  let sanitized = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (SENSITIVE_ENV_NAME.test(name) && secret && secret.length >= 8) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }

  sanitized = sanitized
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(aws_secret_access_key|aws_access_key_id|secret_access_key|access_key_id|database_url|authorization|cookie|password|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return sanitized;
}

export function safeErrorFields(error: unknown) {
  const candidate = error instanceof Error ? error : null;
  return {
    errorName: redact(candidate?.name || "UnknownError").slice(0, 200),
    errorMessage: redact(candidate?.message || "Unknown error").slice(0, 2_000),
    errorStack: candidate?.stack ? redact(candidate.stack).slice(0, 8_000) : undefined,
  };
}

export function logSafeError(event: string, error: unknown, fields: LogFields = {}) {
  log("error", event, { ...fields, ...safeErrorFields(error) });
}
