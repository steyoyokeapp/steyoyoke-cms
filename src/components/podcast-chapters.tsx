"use client";
import { useRef } from "react";
import { formatDuration } from "@/modules/tracks/duration";
import type { TracklistResult } from "@/modules/podcasts/tracklist";
import "./podcast-tracklist.css";

export function PodcastChapters({ text, onChange, onValidate, result, current, disabled }: { text: string; onChange: (text: string) => void; onValidate: () => void; result: TracklistResult | null; current: boolean; disabled: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  function selectLine(line: number) { const lines = text.split("\n"); const start = lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0); input.current?.focus(); input.current?.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0)); }
  return <section className="track-design-section podcast-tracklist"><div className="track-section-heading"><h2>Tracklist</h2><p>Paste the complete Podcast tracklist below. Each line: Artist - Title 1;00:00. Start time is where the track begins, not its length.</p></div>
    <label htmlFor="podcast-tracklist">Complete tracklist</label><textarea ref={input} id="podcast-tracklist" value={text} onChange={e => onChange(e.target.value)} readOnly={disabled} rows={12} maxLength={300000} spellCheck={false} placeholder={'Artist - Track title 1;00:00\nArtist - Next track 2;05:30'} aria-describedby="tracklist-state" aria-invalid={current && Boolean(result?.errors.length)} />
    {!disabled && <button type="button" className="button" onClick={onValidate}>Validate tracklist</button>}
    <div id="tracklist-state" aria-live="polite">
      {!current && <p className="tracklist-stale">{result ? "Tracklist changed — validate again." : "Validate the tracklist before saving. An empty tracklist is allowed."}</p>}
      {current && result && (result.errors.length ? <div className="tracklist-errors" role="alert"><strong>Tracklist has {result.errors.length} error{result.errors.length === 1 ? "" : "s"}</strong><ul>{result.errors.map((error, i) => <li key={i}><button type="button" onClick={() => selectLine(error.line)}>Line {error.line}</button> — {error.message}</li>)}</ul></div> : <div className="tracklist-success"><strong>✓ Tracklist valid</strong><p>{result.chapters.length ? `${result.chapters.length} tracks detected · Last start time: ${formatDuration(result.chapters.at(-1)!.durationMs)}` : "Intentionally empty — no tracks."}</p></div>)}
    </div>
    {current && result && !result.errors.length && result.chapters.length > 0 && <div className="tracklist-preview" role="table" aria-label="Validated tracklist"><div role="row" className="tracklist-preview-heading"><span role="columnheader">#</span><span role="columnheader">Track</span><span role="columnheader">Start time</span></div>{result.chapters.map(c => <div role="row" key={c.position}><span role="cell">{c.position + 1}</span><span role="cell">{c.artist} - {c.title}</span><span role="cell">{formatDuration(c.durationMs)}</span></div>)}</div>}
  </section>;
}
