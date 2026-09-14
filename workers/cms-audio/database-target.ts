/** Reject implicit database targets. Deployment configuration must pin the database and branch. */
export function workerDatabaseTarget(connectionString: string, database?: string, branch?: string) {
  const url = new URL(connectionString);
  if (["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/steyoyoke_cms_test") {
    return { database: "steyoyoke_cms_test", branch: null };
  }
  if (!database || !branch?.startsWith("br-") || !url.hostname.endsWith(".neon.tech") ||
      !["postgres:", "postgresql:"].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== database) {
    throw new Error("Worker database target must match its explicit deployment configuration");
  }
  return { database, branch };
}
