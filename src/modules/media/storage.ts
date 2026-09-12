import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { AppError } from "@/lib/errors";

export interface StorageProvider {
  readonly kind: "LOCAL" | "S3_COMPATIBLE";
  put(key: string, bytes: Buffer, options?: StoragePutOptions): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  getOwnershipToken(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export type StoragePutOptions = { ownershipToken?: string };

const OWNERSHIP_METADATA_KEY = "migration-run-id";

function safeOwnershipToken(token: string | undefined) {
  if (token === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new AppError("Invalid storage ownership token.", 400, "INVALID_STORAGE_OWNERSHIP_TOKEN");
  }
  return token.toLowerCase();
}

function safeKey(key: string) {
  if (!/^[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(key) || key.includes("..") || path.isAbsolute(key)) {
    throw new AppError("Invalid media storage key.", 400, "INVALID_STORAGE_KEY");
  }
  return key;
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind = "LOCAL" as const;
  readonly root: string;

  constructor(root = process.env.MEDIA_STORAGE_ROOT || path.join(process.cwd(), ".local-storage")) {
    this.root = path.resolve(root);
  }

  private resolve(key: string) {
    const target = path.resolve(this.root, safeKey(key));
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new AppError("Invalid media storage key.", 400, "INVALID_STORAGE_KEY");
    return target;
  }

  private ownershipPath(key: string) { return `${this.resolve(key)}.migration-owner`; }

  async put(key: string, bytes: Buffer, options: StoragePutOptions = {}) {
    const target = this.resolve(key);
    const ownershipToken = safeOwnershipToken(options.ownershipToken);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    try {
      if (ownershipToken) await writeFile(this.ownershipPath(key), ownershipToken, { mode: 0o600, flag: "wx" });
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  async read(key: string) { return readFile(this.resolve(key)); }
  async exists(key: string) { try { await stat(this.resolve(key)); return true; } catch { return false; } }
  async getOwnershipToken(key: string) {
    try { return (await readFile(this.ownershipPath(key), "utf8")).trim() || null; }
    catch { return null; }
  }
  async delete(key: string) { await Promise.all([rm(this.resolve(key), { force: true }), rm(this.ownershipPath(key), { force: true })]); }
}

type S3Sender = Pick<S3Client, "send">;

export type S3StorageOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  client?: S3Sender;
};

export class S3StorageProvider implements StorageProvider {
  readonly kind = "S3_COMPATIBLE" as const;
  private readonly client: S3Sender;
  private readonly prefix: string;

  constructor(private readonly options: S3StorageOptions) {
    if (!options.bucket.trim()) throw new Error("MEDIA_S3_BUCKET is required for S3-compatible storage.");
    this.prefix = options.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
    const config: S3ClientConfig = {
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
    };
    if (options.accessKeyId || options.secretAccessKey) {
      if (!options.accessKeyId || !options.secretAccessKey) throw new Error("Both MEDIA_S3_ACCESS_KEY_ID and MEDIA_S3_SECRET_ACCESS_KEY are required.");
      config.credentials = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey };
    }
    this.client = options.client ?? new S3Client(config);
  }

  private objectKey(key: string) {
    const checked = safeKey(key);
    return this.prefix ? `${this.prefix}/${checked}` : checked;
  }

  async put(key: string, bytes: Buffer, options: StoragePutOptions = {}) {
    const ownershipToken = safeOwnershipToken(options.ownershipToken);
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: this.objectKey(key),
      Body: bytes,
      ContentLength: bytes.length,
      IfNoneMatch: "*",
      ...(ownershipToken ? { Metadata: { [OWNERSHIP_METADATA_KEY]: ownershipToken } } : {}),
    }));
  }

  async read(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }));
    if (!result.Body) throw new Error("Storage object has no body.");
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }));
      return true;
    } catch (error) {
      const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }

  async getOwnershipToken(key: string) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }));
    return result.Metadata?.[OWNERSHIP_METADATA_KEY]?.toLowerCase() ?? null;
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }));
  }
}

export function createStorageProvider(environment: Record<string, string | undefined> = process.env): StorageProvider {
  const provider = environment.MEDIA_STORAGE_PROVIDER?.trim().toLowerCase() || "local";
  if (provider === "local") return new LocalStorageProvider(environment.MEDIA_STORAGE_ROOT);
  if (provider !== "s3") throw new Error("MEDIA_STORAGE_PROVIDER must be local or s3.");
  const value = (name: string) => {
    const result = environment[name]?.trim();
    if (!result) throw new Error(`${name} is required when MEDIA_STORAGE_PROVIDER=s3.`);
    return result;
  };
  return new S3StorageProvider({
    bucket: value("MEDIA_S3_BUCKET"),
    region: environment.MEDIA_S3_REGION?.trim() || "us-east-1",
    endpoint: environment.MEDIA_S3_ENDPOINT?.trim() || undefined,
    accessKeyId: environment.MEDIA_S3_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey: environment.MEDIA_S3_SECRET_ACCESS_KEY?.trim() || undefined,
    forcePathStyle: environment.MEDIA_S3_FORCE_PATH_STYLE === "true",
    prefix: environment.MEDIA_S3_PREFIX?.trim() || undefined,
  });
}

export const localStorage = new LocalStorageProvider();
export const mediaStorage = createStorageProvider();
