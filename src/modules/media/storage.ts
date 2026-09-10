import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { AppError } from "@/lib/errors";

export interface StorageProvider {
  put(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

function safeKey(key: string) {
  if (!/^[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(key) || key.includes("..") || path.isAbsolute(key)) {
    throw new AppError("Invalid media storage key.", 400, "INVALID_STORAGE_KEY");
  }
  return key;
}

export class LocalStorageProvider implements StorageProvider {
  readonly root: string;

  constructor(root = process.env.MEDIA_STORAGE_ROOT || path.join(process.cwd(), ".local-storage")) {
    this.root = path.resolve(root);
  }

  private resolve(key: string) {
    const target = path.resolve(this.root, safeKey(key));
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new AppError("Invalid media storage key.", 400, "INVALID_STORAGE_KEY");
    return target;
  }

  async put(key: string, bytes: Buffer) {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  }

  async read(key: string) { return readFile(this.resolve(key)); }
  async exists(key: string) { try { await stat(this.resolve(key)); return true; } catch { return false; } }
  async delete(key: string) { await rm(this.resolve(key), { force: true }); }
}

export const localStorage = new LocalStorageProvider();
