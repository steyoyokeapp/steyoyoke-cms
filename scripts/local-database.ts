const LOCAL_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function assertLocalCmsDatabase(databaseUrl: string | undefined) {
  let target: URL;
  try { target = new URL(databaseUrl ?? ""); }
  catch { throw new Error("Password reset requires a valid local DATABASE_URL."); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) || !LOCAL_DATABASE_HOSTS.has(target.hostname) || target.pathname !== "/steyoyoke_cms_local") {
    throw new Error("Password reset is restricted to the local steyoyoke_cms_local database.");
  }
}
