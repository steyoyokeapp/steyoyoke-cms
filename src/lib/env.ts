import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  APP_BASE_URL: z.string().url().optional(),
  LEGACY_API_KEY_A: z.string().min(16),
  LEGACY_API_KEY_B: z.string().min(16),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SCHEDULED_PUBLISHER_ENABLED: z.enum(["true", "false"]).default("false"),
});

export const env = envSchema.parse(process.env);
