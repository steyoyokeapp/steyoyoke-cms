import { PrismaPg } from "@prisma/adapter-pg";
import { attachDatabasePool } from "@vercel/functions";
import { PrismaClient } from "@/generated/prisma/client";
import { DatabasePool } from "@/lib/database-pool";
import { env } from "@/lib/env";

type DatabaseRuntime = { pool: DatabasePool; prisma: PrismaClient };
const globalForPrisma = globalThis as unknown as { databaseRuntime?: DatabaseRuntime };

function createDatabaseRuntime(): DatabaseRuntime {
  const pool = new DatabasePool(env.DATABASE_URL);
  if (process.env.VERCEL === "1") attachDatabasePool(pool);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
  return { pool, prisma };
}

// Module scope reuses warm instances; the global also guards dev HMR and repeated
// module evaluation within the same runtime. Nothing is shared across instances.
const runtime = globalForPrisma.databaseRuntime ??= createDatabaseRuntime();
export const prisma = runtime.prisma;
