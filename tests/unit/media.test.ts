import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { requirePermission } from "@/lib/authorization";
import { checksum, IMAGE_VARIANTS, MAX_IMAGE_BYTES, processImage } from "@/modules/media/image";
import { LegacyMediaSerializer } from "@/modules/media/legacy";
import { LocalStorageProvider } from "@/modules/media/storage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("local image processing", () => {
  it.each([[400, 500], [900, 400]])("preserves portrait/landscape aspect ratio and never upscales %sx%s", async (width, height) => {
    const bytes = await sharp({ create: { width, height, channels: 3, background: "#314159" } }).jpeg().toBuffer(); const result = await processImage(bytes);
    expect(result.variants.map(({ variantKey }) => variantKey)).toEqual(IMAGE_VARIANTS.map(([key]) => key));
    expect(result.variants[1]!.width).toBe(width); expect(result.variants[1]!.height).toBe(height);
    const thumb = result.variants.at(-1)!; expect(Math.max(thumb.width, thumb.height)).toBe(80); expect(result.sourceChecksum).toBe(checksum(bytes));
    expect(result.variants.every((variant) => variant.sha256Checksum.length === 64)).toBe(true);
  });

  it("keeps alpha images as PNG", async () => {
    const result = await processImage(await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.3 } } }).png().toBuffer());
    expect(result.variants.every(({ mimeType, extension }) => mimeType === "image/png" && extension === "png")).toBe(true);
  });

  it("rejects corrupt, SVG, and oversized bytes cleanly", async () => {
    await expect(processImage(Buffer.from("not an image"))).rejects.toMatchObject({ code: "IMAGE_INVALID" });
    await expect(processImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'))).rejects.toMatchObject({ code: "IMAGE_FORMAT_INVALID" });
    await expect(processImage(Buffer.alloc(MAX_IMAGE_BYTES + 1))).rejects.toMatchObject({ code: "IMAGE_SIZE_INVALID" });
  });

  it("maps all five legacy cover fields through one normalized serializer", () => {
    const asset = { id: crypto.randomUUID(), status: "READY", compatibilityFilename: "safe.jpg" } as never;
    expect(LegacyMediaSerializer.covers(asset)).toEqual({ cover_download: "/assets/uploads/files/safe.jpg", cover_thumbnail_low: "/assets/uploads/files/thumbnails/256/safe.jpg", cover_thumbnail_high: "/assets/uploads/files/512/safe.jpg", cover_low: "/assets/uploads/files/1024/safe.jpg", cover_high: "/assets/uploads/files/1440/safe.jpg" });
    expect(LegacyMediaSerializer.covers(null).cover_high).toBeNull();
  });

  it("confines local storage keys to its root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "steyoyoke-media-")); roots.push(root); const storage = new LocalStorageProvider(root);
    await storage.put("images/test/source.jpg", Buffer.from("safe")); expect(await storage.exists("images/test/source.jpg")).toBe(true); expect((await storage.read("images/test/source.jpg")).toString()).toBe("safe");
    await expect(storage.read("../secret.jpg")).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" }); await storage.delete("images/test/source.jpg"); expect(await storage.exists("images/test/source.jpg")).toBe(false);
  });

  it("enforces media permissions by role", () => {
    const id = crypto.randomUUID(); expect(() => requirePermission({ userId: id, role: "VIEWER" }, "media:read")).not.toThrow(); expect(() => requirePermission({ userId: id, role: "VIEWER" }, "media:upload")).toThrow();
    expect(() => requirePermission({ userId: id, role: "EDITOR" }, "media:upload")).not.toThrow(); expect(() => requirePermission({ userId: id, role: "EDITOR" }, "media:retire")).toThrow(); expect(() => requirePermission({ userId: id, role: "ADMIN" }, "media:purge")).not.toThrow();
  });
});
