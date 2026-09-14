import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { audioLimits, type AudioProfile } from "./track-audio-contract";
const execute = promisify(execFile);
export async function probeAudio(path: string, profile: AudioProfile = "track") {
  const { stdout } = await execute(process.env.FFPROBE_BINARY || "ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const streams = data.streams as Array<{ codec_type: string; codec_name: string; channels: number; bit_rate?: string; duration?: string; disposition?: { attached_pic?: number } }>;
  if (streams.filter(s => s.codec_type === "audio").length !== 1 || streams.some(s => s.codec_type !== "audio" && s.disposition?.attached_pic !== 1)) throw new Error("Choose a file with one audio stream and no video.");
  const stream = streams.find(s => s.codec_type === "audio")!; const duration = Number(data.format.duration ?? stream.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > audioLimits(profile).seconds) throw new Error("Audio duration is outside the supported range.");
  return { codec: stream.codec_name, container: data.format.format_name as string, channels: stream.channels, bitrate: Number(stream.bit_rate), duration };
}
export async function transcodeTrackAudio(source: string, destination: string, profile: AudioProfile = "track") {
  const size = (await stat(source)).size;
  if (!size || size > audioLimits(profile).bytes) throw new Error("Audio exceeds the upload size limit.");
  const input = await probeAudio(source, profile);
  if (!((input.container === "mp3" && input.codec === "mp3") || (input.container === "wav" && input.codec.startsWith("pcm_")))) throw new Error("Only valid MP3 and PCM WAV files are supported.");
  await execute(process.env.FFMPEG_BINARY || "ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", source, "-map", "0:a:0", "-map_metadata", "-1", "-vn", "-c:a", "libmp3lame", "-b:a", "128k", "-ac", "2", "-ar", "44100", "-threads", "1", destination], { timeout: 720_000, maxBuffer: 1024 * 1024 });
  const output = await probeAudio(destination, profile);
  if (output.codec !== "mp3" || output.container !== "mp3" || output.bitrate !== 128000 || output.channels !== 2 || Math.abs(output.duration - input.duration) > 0.15) throw new Error("Generated audio failed delivery verification.");
  return { ...output, durationMs: Math.round(output.duration * 1000), byteSize: (await stat(destination)).size };
}
