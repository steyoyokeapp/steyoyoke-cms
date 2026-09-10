import dotenv from "dotenv";

dotenv.config({ path: ".env", quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for tests.");
process.env.DATABASE_URL = process.env.DATABASE_URL.replace("steyoyoke_cms_local", "steyoyoke_cms_test");
