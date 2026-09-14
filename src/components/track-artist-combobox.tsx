"use client";
import { useEffect, useId, useState } from "react";
import type { TrackOption } from "./track-create-form";
import styles from "./tracks-filters.module.css";
export function TrackArtistCombobox({ label, value, initial, onChange, disabled, required }: { label: string; value: string; initial: TrackOption[]; onChange: (id: string) => void; disabled: boolean; required?: boolean }) {
  const id = useId(); const [selected, setSelected] = useState(initial.find(x => x.id === value));
  const [query, setQuery] = useState(selected?.name ?? ""); const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TrackOption[]>([]); const [active, setActive] = useState(-1); const [error, setError] = useState("");
  const search = query === selected?.name ? "" : query;
  useEffect(() => {
    if (!open || disabled) return;
    const controller = new AbortController(); let current = true;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/admin/choices?${new URLSearchParams({ kind: "artist", q: search })}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Could not search Artists.");
        const results = await response.json(); if (current) { setRows(results); setError(""); }
      } catch { if (current && !controller.signal.aborted) setError("Could not search Artists."); }
    }, 250);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [open, search, disabled]);
  function choose(row?: TrackOption) { setSelected(row); setQuery(row?.name ?? ""); onChange(row?.id ?? ""); setOpen(false); setActive(-1); }
  const choices = [...(selected ? [selected] : []), ...rows.filter(x => x.id !== selected?.id)];
  return <div className={styles.artist} style={{ position: "relative" }}>
    <label htmlFor={id}>{label}</label>
    <div style={{ display: "flex", gap: 8 }}>
      <input id={id} role="combobox" aria-expanded={open} aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={open && active >= 0 && active < choices.length ? `${id}-${active}` : undefined}
        placeholder="Start typing artist name…" autoComplete="off" maxLength={200} disabled={disabled} required={required} value={query}
        onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setQuery(selected?.name ?? ""); }}
        onChange={e => { setQuery(e.target.value); setRows([]); setActive(-1); setOpen(true); }}
        onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive(i => Math.max(0, Math.min(choices.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); } else if (e.key === "Enter" && open) { e.preventDefault(); if (choices[active]) choose(choices[active]); } else if (e.key === "Escape") { setOpen(false); setQuery(selected?.name ?? ""); } }} />
      {selected && !disabled && <button type="button" className="button" aria-label={`Clear ${label}`} onClick={() => choose()}>Clear</button>}
    </div>
    {open && <div className={styles.popup}><ul id={`${id}-list`} role="listbox" aria-label={`${label} choices`}>
      {choices.map((row, index) => <li id={`${id}-${index}`} key={row.id} role="option" aria-selected={row.id === value} className={index === active ? styles.active : undefined} onMouseDown={e => e.preventDefault()} onClick={() => choose(row)}>{row.name}</li>)}
    </ul>{error && <p role="alert">{error}</p>}{!choices.length && <p className="muted">Type to find an Artist.</p>}</div>}
  </div>;
}
