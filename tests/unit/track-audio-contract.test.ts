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
