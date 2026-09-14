import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAudio } from "@/modules/media/transcode-track-audio";
it("accepts actual long-form Podcast audio while preserving the Track duration ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "podcast-limit-"));
  try {
    const file = join(directory, "long.mp3");
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1801", "-c:a", "libmp3lame", "-b:a", "8k", file], { timeout: 30000 });
    await expect(probeAudio(file)).rejects.toThrow("duration is outside");
    expect((await probeAudio(file, "podcast")).duration).toBeGreaterThan(1800);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 40000);
