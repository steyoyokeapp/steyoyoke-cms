"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import styles from "./tracks-filters.module.css";

type Artist = { id: string; name: string; legacyId?: number };
type Filters = { q?: string; artistId?: string; labelId?: string; status?: string };

function ArtistFilter({ initial }: { initial?: Artist }) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState(initial?.name ?? "");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Artist[]>([]);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Reopening a selection shows choices; typing searches the same bounded endpoint.
  const search = query === selected?.name ? "" : query;
  useEffect(() => {
    if (!open) return;
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const response = await fetch(`/api/admin/choices?${new URLSearchParams({ kind: "artist-filter", q: search })}`, {
          signal: controller.signal, cache: "no-store",
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "Could not search Artists.");
        if (current) { setResults(body); setError(""); }
      } catch (caught) {
        if (current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not search Artists.");
      } finally { if (current) setBusy(false); }
    }, 250);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [open, search]);

  useEffect(() => {
    if (open && active >= 0) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choices: (Artist | undefined)[] = [undefined, ...(selected ? [selected] : []), ...results.filter(x => x.id !== selected?.id)];
  function close() { setOpen(false); setActive(-1); setQuery(selected?.name ?? ""); }
  function choose(artist: Artist | undefined) {
    setSelected(artist); setQuery(artist?.name ?? ""); setOpen(false); setActive(-1);
  }
  return (
    <div className={`${styles.field} ${styles.artist}`}>
      <label htmlFor={id}>Artist</label>
      <input type="hidden" name="artistId" value={selected?.id ?? ""} />
      <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open}
        aria-controls={`${id}-options`} aria-activedescendant={open && active >= 0 && active < choices.length ? `${id}-option-${active}` : undefined}
        value={query} placeholder="All Artists" autoComplete="off" maxLength={200}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={close}
        onChange={event => { setQuery(event.target.value); setResults([]); setError(""); setActive(-1); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setOpen(true);
            setActive(index => event.key === "ArrowDown" ? Math.min(index + 1, choices.length - 1) : Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open) {
            event.preventDefault(); if (active >= 0 && active < choices.length) choose(choices[active]);
          } else if (event.key === "Escape") { event.preventDefault(); close(); }
        }} />
      {open && <div className={styles.popup}>
        <ul ref={list} id={`${id}-options`} role="listbox" aria-label="Artist choices" aria-busy={busy}>
          {choices.map((artist, index) => <li key={artist?.id ?? "all"} id={`${id}-option-${index}`} role="option"
            aria-selected={artist?.id === selected?.id} className={index === active ? styles.active : undefined}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(artist)}>
            {artist?.name ?? "All Artists"}{artist?.legacyId !== undefined && <small> #{artist.legacyId}</small>}
          </li>)}
        </ul>
        {busy && <div role="status" className={styles.message}>Searching…</div>}
        {error && <div role="alert" className={styles.message}>{error}</div>}
        {!busy && !error && search && results.length === 0 && <div className={styles.message}>No matching Artists</div>}
      </div>}
    </div>
  );
}

export function TracksFilters({ filters, artists, labels }: { filters: Filters; artists: Artist[]; labels: { id: string; name: string }[] }) {
  const active = Boolean(filters.q || filters.artistId || filters.labelId || filters.status);
  return (
    <form action="/admin/tracks" method="get" aria-label="Track filters" className={`panel ${styles.toolbar}`}>
      <label className={`${styles.field} ${styles.title}`}>Search title<input name="q" defaultValue={filters.q} placeholder="Search title" /></label>
      <ArtistFilter initial={artists.find(x => x.id === filters.artistId)} />
      <label className={styles.field}>Label<select name="labelId" defaultValue={filters.labelId ?? ""}>
        <option value="">All Labels</option>{labels.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select></label>
      <label className={styles.field}>Status<select name="status" defaultValue={filters.status ?? ""}>
        <option value="">All statuses</option>{["DRAFT", "SCHEDULED", "PUBLISHED", "UNPUBLISHED", "ARCHIVED"].map(x => <option key={x}>{x}</option>)}
      </select></label>
      <button className={`button ${styles.submit}`} type="submit">Filter</button>
      {active && <Link className={styles.clear} href="/admin/tracks" prefetch={false}>Clear filters</Link>}
    </form>
  );
}
