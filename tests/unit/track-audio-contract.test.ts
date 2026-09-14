import { describe, it, expect } from "vitest";
import { trackAudioFilename, defaultTrackStores } from "@/modules/media/track-audio-contract";
describe("Track audio naming", () => {
  it.each(["SYYK302_1.wav", "SYYK302_1.mp3", "SYYK302_1-high.mp3"])("normalizes %s", input => {
    expect(trackAudioFilename(input)).toMatchObject({ identity: "SYYK302_1", key: "SYYK302_1-high.mp3", catalogue: "syyk302" });
  });
  it.each(["SYYK302_10.wav", "SYYK047_01.mp3", "SYYK15YA_1.wav", "IS081_2.mp3"])("accepts historical convention %s", input => expect(trackAudioFilename(input).catalogue).not.toBeNull());
  it.each(["../SYYK302_1.wav", "a-high-high.mp3", "a.flac"])("rejects unsafe or unsupported %s", input => expect(() => trackAudioFilename(input)).toThrow());
  it("keeps unmatched filenames usable without inventing store links", () => {
    expect(defaultTrackStores("My_track.wav")).toEqual({}); expect(defaultTrackStores("SYYK302_0.wav")).toEqual({});
  });
  it("generates the five exact editable defaults", () => expect(defaultTrackStores("SYYK302_10.wav")).toEqual({ spotifyUrl: "https://syykrec.com/syyk302/spotify", appleMusicUrl: "https://syykrec.com/syyk302/applemusic", bandcampUrl: "https://syykrec.com/syyk302/bandcamp", beatportUrl: "https://syykrec.com/syyk302/beatport", traxsourceUrl: "https://syykrec.com/syyk302/traxsource" }));
});

import { audioLimits, sourceAudioProfile } from "@/modules/media/track-audio-contract";
import { hashUpload } from "@/modules/media/hash-upload";
import { createHash } from "node:crypto";
it("keeps Track limits separate from server-reserved Podcast sources", () => {
  expect(audioLimits()).toEqual({ bytes: 512 * 1024 * 1024, seconds: 1800 });
  expect(audioLimits("podcast")).toEqual({ bytes: 2_000_000_000, seconds: 7200 });
  expect(sourceAudioProfile("audio-originals/id/podcast-source.wav", "id")).toBe("podcast");
  expect(sourceAudioProfile("audio-originals/id/source.wav", "id")).toBe("track");
  expect(() => sourceAudioProfile("audio-originals/other/podcast-source.wav", "id")).toThrow();
});
it("hashes across chunk boundaries without reading the entire Blob", async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 31, 47); const file = new Blob([bytes]);
  file.arrayBuffer = () => { throw new Error("Whole-file buffering prohibited"); };
  expect(await hashUpload(file, new AbortController().signal)).toBe(createHash("sha256").update(bytes).digest("hex"));
  const abort = new AbortController(); abort.abort(); await expect(hashUpload(file, abort.signal)).rejects.toThrow();
});
