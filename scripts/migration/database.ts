import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { REHEARSAL_DATABASE } from "./config";

export function migrationClient(databaseUrl: string, maxConnections = 10) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: maxConnections }) });
}

export async function resetRehearsalDatabase(databaseUrl: string) {
  const target = new URL(databaseUrl);
  if (target.pathname !== `/${REHEARSAL_DATABASE}` || !["127.0.0.1", "localhost", "::1"].includes(target.hostname)) throw new Error("Refusing to reset anything except the dedicated local rehearsal database.");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally { await client.end(); }
}

export function applyMigrations(databaseUrl: string) {
  execFileSync(path.join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "inherit",
  });
}
