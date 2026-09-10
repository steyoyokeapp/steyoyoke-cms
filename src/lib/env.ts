import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  LEGACY_API_KEY_A: z.string().min(16),
  LEGACY_API_KEY_B: z.string().min(16),
});

export const env = envSchema.parse(process.env);
