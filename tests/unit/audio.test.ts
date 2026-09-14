import { describe, expect, it } from "vitest";
import type { MediaAsset } from "@/generated/prisma/client";
import { processAudio } from "@/modules/media/audio";
import { formatAudioDuration } from "@/modules/media/format";
import { LegacyAudioSerializer } from "@/modules/media/legacy";
import { testMp3 } from "@/../tests/fixtures/audio";

const asset = { id: crypto.randomUUID(), kind: "AUDIO", status: "READY", provider: "LOCAL", audioDelivery: null, sourceStorageKey: `audio/${crypto.randomUUID()}/source.mp3`, compatibilityFilename: null, legacyAudioId: "historical_key-17", originalFilename: "episode.mp3", mimeType: "audio/mpeg", byteSize: 100, sha256Checksum: "a".repeat(64), width: null, height: null, durationMs: 1234, createdById: crypto.randomUUID(), failureReason: null, unreferencedAt: null, retiredAt: null, createdAt: new Date(), updatedAt: new Date() } satisfies MediaAsset;

describe("local audio contract", () => {
  it("validates actual MP3 bytes and extracts stable metadata", async () => { const result = await processAudio(testMp3()); expect(result).toMatchObject({ mimeType: "audio/mpeg", extension: "mp3", durationMs: 287 }); expect(result.sha256Checksum).toMatch(/^[a-f0-9]{64}$/); });
  it.each([Buffer.alloc(0), Buffer.from("not audio"), Buffer.from("RIFF fake wav")])("rejects zero, corrupt, and unsupported bytes", async (bytes) => { await expect(processAudio(bytes)).rejects.toMatchObject({ code: expect.stringMatching(/^AUDIO_/) }); });
  it("formats duration and preserves raw Track versus URL Podcast semantics", () => { expect(formatAudioDuration(287)).toBe("0:00"); expect(formatAudioDuration(3_725_000)).toBe("1:02:05"); expect(LegacyAudioSerializer.track(asset)).toBe("historical_key-17"); expect(LegacyAudioSerializer.podcast(asset, "/legacy-audio/")).toBe("/legacy-audio/historical_key-17-high.mp3"); });
  it("returns null for non-ready or image assets", () => { expect(LegacyAudioSerializer.track({ ...asset, status: "FAILED" })).toBeNull(); expect(LegacyAudioSerializer.track({ ...asset, kind: "IMAGE" })).toBeNull(); });
});
