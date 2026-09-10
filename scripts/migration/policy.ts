export const NORMALIZATION_RULES_VERSION = "phase-12-v1";

export const NORMALIZATION_RULES = [
  "ZERO_PAD_UNAMBIGUOUS_ISO_MONTH_DAY",
  "NORMALIZE_CHAPTER_HOURS_MINUTES_SECONDS",
  "NORMALIZE_CHAPTER_TIMESTAMP_WHITESPACE",
  "NORMALIZE_HTTP_TO_HTTPS",
  "NORMALIZE_SECONDARY_ARTIST_ZERO_TO_NULL",
  "RECOVER_UNIQUE_ARTWORK_HASH_PREFIX",
] as const;

export const MIGRATION_SEVERITY_POLICY = {
  BLOCKER: "Entity cannot be safely published.",
  WARNING: "Entity can publish, but an owner should review the anomaly.",
  COMPATIBILITY: "Canonical data is valid and the compatibility projection intentionally differs internally from legacy storage.",
  INFORMATIONAL: "Expected normalization or optional absence; no owner action is required.",
} as const;
