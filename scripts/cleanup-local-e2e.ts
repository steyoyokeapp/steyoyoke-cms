import "dotenv/config";
import { assertLocalCmsDatabase } from "./local-database";

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--apply";
if (args.length && !apply) {
  console.error("Usage: npm run dev:cleanup-e2e [-- --apply]");
  process.exit(1);
}

assertLocalCmsDatabase(process.env.DATABASE_URL, "Local E2E cleanup");
const [{ applyLocalE2ECleanup, previewLocalE2ECleanup }, { prisma }] = await Promise.all([import("../src/lib/dev-cleanup"), import("../src/lib/prisma")]);
try {
  const counts = apply ? await applyLocalE2ECleanup() : await previewLocalE2ECleanup();
  console.log(apply ? "Applied local E2E cleanup:" : "Local E2E cleanup dry run:");
  for (const [name, count] of Object.entries(counts)) console.log(`${name}: ${count}`);
  if (!apply) console.log("No rows changed. Run npm run dev:cleanup-e2e -- --apply to remove exactly these eligible records.");
} catch {
  console.error("Local E2E cleanup failed without changing data.");
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
