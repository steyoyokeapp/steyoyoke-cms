import { formatDuration } from "@/modules/tracks/duration";

export type TracklistChapter = { artist: string; title: string; durationMs: number | null; legacyReference?: string | null };
export type TracklistError = { line: number; message: string };
export type TracklistResult = { chapters: Array<TracklistChapter & { position: number }>; errors: TracklistError[] };
const trackText = (chapter: TracklistChapter) => `${chapter.artist} - ${chapter.title}`;
export const formatTracklist = (chapters: TracklistChapter[]) => chapters.map((c, i) => `${trackText(c)} ${i + 1};${formatDuration(c.durationMs) ?? ""}`).join("\n");

/** Metadata is read from the final suffix; punctuation within track text is preserved. */
export function validateTracklist(text: string, durationMs: number | null = null, previous: TracklistChapter[] = []): TracklistResult {
  const errors: TracklistError[] = [], chapters: TracklistResult["chapters"] = [];
  const fail = (line: number, message: string) => errors.push({ line, message });
  if (text.length > 300_000) return { chapters: [], errors: [{ line: 1, message: "Tracklist is too large. Use at most 500 tracks." }] };
  const lines = text.split(/\r?\n/).map((value, index) => ({ value: value.trim(), line: index + 1 })).filter(x => x.value);
  if (lines.length > 500) return { chapters: [], errors: [{ line: lines[500]!.line, message: "Use at most 500 tracks." }] };
  const seen = new Set<number>(); let lastStart: number | null = null;
  const originals = new Map<string, TracklistChapter[]>();
  for (const chapter of previous) { const key = trackText(chapter); originals.set(key, [...(originals.get(key) ?? []), chapter]); }
  for (const [position, { value, line }] of lines.entries()) {
    const separator = value.lastIndexOf(";");
    if (separator < 0) {
      const typo = /(?:^|\s)(\d+):(\d{2,}:\d{2}(?::\d{2})?)$/.exec(value);
      fail(line, typo ? `";" is missing after track number. Found: ${typo[1]}:${typo[2]}. Did you mean: ${typo[1]};${typo[2]}?` : 'Missing ";" after track number. Use Artist - Title 1;00:00.'); continue;
    }
    const left = value.slice(0, separator).trim(), start = value.slice(separator + 1).trim();
    const suffix = /^(.*)\s+(\S+)$/.exec(left);
    const name = suffix?.[1]?.trim() ?? "", rawNumber = suffix?.[2] ?? left;
    const number = Number(rawNumber);
    if (!/^\d+$/.test(rawNumber) || !Number.isSafeInteger(number) || number <= 0) fail(line, "Track number must be a positive whole number, starting at 1.");
    else { if (seen.has(number)) fail(line, `Track number ${number} is duplicated. Expected track number ${position + 1}.`);
      else if (number !== position + 1) fail(line, `Track number ${number} is out of sequence. Expected track number ${position + 1}.`); seen.add(number); }
    let time: number | null = null;
    if (!start) fail(line, "Start time is missing. Use MM:SS or HH:MM:SS.");
    else if (!/^\d{2,}:\d{2}(?::\d{2})?$/.test(start)) fail(line, `Invalid timestamp "${start}". Use MM:SS or HH:MM:SS.`);
    else {
      const parts = start.split(":").map(Number), seconds = parts.at(-1)!;
      if (seconds > 59 || (parts.length === 3 && parts[1]! > 59)) fail(line, `Invalid timestamp "${start}". Seconds and minutes within HH:MM:SS must be 00–59.`);
      else { time = parts.reduce((total, part) => total * 60 + part, 0) * 1000;
        if (!Number.isSafeInteger(time) || time > 2_147_483_647) { fail(line, "Start time is too large to store."); time = null; }
      }
    }
    const candidates = originals.get(name) ?? [];
    const original = previous[position] && trackText(previous[position]!) === name ? previous[position] : candidates.length === 1 ? candidates[0] : undefined;
    const split = name.indexOf(" - ");
    const artist = original?.artist ?? (split >= 0 ? name.slice(0, split).trim() : ""), title = original?.title ?? (split >= 0 ? name.slice(split + 3).trim() : "");
    if (!name) fail(line, "Track text is missing. Enter Artist - Title before the track number.");
    else if (!artist || !title) fail(line, 'Enter both Artist and Title, separated by " - ".');
    else if (artist.length > 255 || title.length > 255) fail(line, "Artist and Title must each contain at most 255 characters.");
    // Preserve sub-second historical precision when its displayed timestamp is unchanged.
    if (time !== null && original?.durationMs != null && formatDuration(original.durationMs) === formatDuration(time)) time = original.durationMs;
    if (time !== null) {
      if (lastStart !== null && time <= lastStart) fail(line, `Start time ${start} is ${time === lastStart ? "the same as" : "earlier than"} the previous track at ${formatDuration(lastStart)}. Start times must move forward.`);
      if (durationMs !== null && time >= durationMs) fail(line, `Start time ${start} is at or beyond the Podcast duration of ${formatDuration(durationMs)}.`);
      lastStart = time;
    }
    chapters.push({ position, artist, title, durationMs: time, legacyReference: original ? original.legacyReference ?? null : String(number) });
  }
  return { chapters: errors.length ? [] : chapters, errors };
}
