"use client";
import type { PodcastChapterData } from "./podcast-editor";
import { formatDuration, parseDuration } from "@/modules/tracks/duration";
export type EditableChapter = { key: string; artist: string; title: string; legacyReference: string; start: string };
export const editableChapters = (chapters: PodcastChapterData[]) => chapters.map(c => ({ key: c.id ?? crypto.randomUUID(), artist: c.artist, title: c.title, legacyReference: c.legacyReference ?? "", start: formatDuration(c.durationMs) ?? "" }));
export const chapterPayload = (chapters: EditableChapter[]) => chapters.map((c, position) => ({ position, artist: c.artist, title: c.title, legacyReference: c.legacyReference, durationMs: parseDuration(c.start) }));
export function PodcastChapters({ value, onChange, disabled }: { value: EditableChapter[]; onChange: (chapters: EditableChapter[]) => void; disabled: boolean }) {
  function patch(index: number, change: Partial<EditableChapter>) { onChange(value.map((c, i) => i === index ? { ...c, ...change } : c)); }
  function move(from: number, to: number) { if (to < 0 || to >= value.length) return; const next = [...value]; const [chapter] = next.splice(from, 1); next.splice(to, 0, chapter!); onChange(next); }
  return <section className="track-design-section podcast-chapters"><div className="track-section-heading"><h2>Chapters / tracklist</h2><p>Add the tracks in playback order. Start time is where each chapter begins in the episode.</p></div>
    {!value.length && <p className="empty-inline">No chapters yet. You can add them now or after creating the Podcast.</p>}
    <div className="podcast-chapter-list">{value.map((chapter, index) => <div className="podcast-chapter-card" key={chapter.key}>
      <div className="podcast-chapter-heading"><strong>Chapter {index + 1}</strong>{!disabled && <div className="chapter-actions"><button type="button" className="button" aria-label={`Move Chapter ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button><button type="button" className="button" aria-label={`Move Chapter ${index + 1} down`} disabled={index === value.length - 1} onClick={() => move(index, index + 1)}>↓</button><button type="button" className="button" aria-label={`Remove Chapter ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove</button></div>}</div>
      <div className="podcast-chapter-fields"><label>Title<input aria-label={`Chapter ${index + 1} Title`} value={chapter.title} onChange={e => patch(index, { title: e.target.value })} readOnly={disabled} maxLength={255} required /></label><label>Artist<input aria-label={`Chapter ${index + 1} Artist`} value={chapter.artist} onChange={e => patch(index, { artist: e.target.value })} readOnly={disabled} maxLength={255} required /></label><label>Start time<input aria-label={`Chapter ${index + 1} Start time`} value={chapter.start} onChange={e => patch(index, { start: e.target.value })} readOnly={disabled} placeholder="03:45 or 01:03:45" pattern="(?:[0-9]{2}:)?[0-9]{2}:[0-9]{2}" /></label></div>
    </div>)}</div>
    {!disabled && <button type="button" className="button" disabled={value.length >= 500} onClick={() => onChange([...value, { key: crypto.randomUUID(), title: "", artist: "", legacyReference: "", start: "" }])}>Add Chapter</button>}
  </section>;
}
