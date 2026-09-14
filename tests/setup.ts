import dotenv from "dotenv";

dotenv.config({ path: ".env", quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for tests.");
process.env.DATABASE_URL = process.env.DATABASE_URL.replace("steyoyoke_cms_local", "steyoyoke_cms_test");

const testDatabase = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(testDatabase.hostname) || testDatabase.pathname !== "/steyoyoke_cms_test") {
  throw new Error("The general destructive suite requires the isolated local steyoyoke_cms_test database. Use the explicit worker validation harness for Neon.");
}
