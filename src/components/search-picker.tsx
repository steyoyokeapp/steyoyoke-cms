"use client";
import { useEffect, useState } from "react";
type Choice = { id: string };
/** Component-owned results only: no cross-user or cross-page data cache. */
export function SearchPicker<T extends Choice>({
  kind,
  label,
  value,
  initial,
  onChange,
  describe,
  disabled = false,
  name,
  required = false,
  empty = "None",
}: {
  kind: string;
  label: string;
  value: string;
  initial: T[];
  onChange: (id: string, choice?: T) => void;
  describe: (item: T) => string;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  empty?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<T[]>([]);
  const [selected, setSelected] = useState<T | undefined>(
    initial.find((x) => x.id === value),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || disabled) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        setBusy(true);
        try {
          const response = await fetch(
            `/api/admin/choices?${new URLSearchParams({ kind, q: query })}`,
            { signal: controller.signal, cache: "no-store" },
          );
          const body = await response.json();
          if (!response.ok)
            throw new Error(body.error?.message ?? "Could not search.");
          if (active) {
            setResults(body);
            setError("");
          }
        } catch (e) {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "Could not search.");
        } finally {
          if (active) setBusy(false);
        }
      },
      query ? 250 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, kind, open, disabled]);
  const current =
    selected?.id === value ? selected : initial.find((x) => x.id === value);
  const options = [
    ...(current ? [current] : []),
    ...(open ? results : initial.slice(0, 25)).filter(
      (x) => x.id !== current?.id,
    ),
  ];
  return (
    <div className="search-picker">
      <label>
        Search {label}
        <input
          aria-label={`Search ${label}`}
          value={query}
          disabled={disabled}
          placeholder="Search by name"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
      </label>
      <label>
        {label}
        <select
          aria-label={label}
          name={name}
          value={value}
          required={required}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            const item = options.find((x) => x.id === e.target.value);
            setSelected(item);
            onChange(e.target.value, item);
          }}
        >
          <option value="">{empty}</option>
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {describe(item)}
            </option>
          ))}
        </select>
      </label>
      {busy && <small role="status">Searching…</small>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
