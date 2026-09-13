"use client";
import { useState } from "react";
import { SearchPicker } from "./search-picker";
export function CatalogueFilters({
  kind,
  filters,
  artists,
  labels,
}: {
  kind: string;
  filters: { q?: string; artistId?: string; labelId?: string; status?: string };
  artists: { id: string; name: string }[];
  labels: { id: string; name: string }[];
}) {
  const [artistId, setArtistId] = useState(filters.artistId ?? "");
  return (
    <form className="panel filter-bar">
      <input
        name="q"
        defaultValue={filters.q}
        placeholder={kind === "artists" ? "Search name" : "Search title"}
      />
      {kind !== "artists" && (
        <>
          <SearchPicker
            kind="artist-filter"
            label="Artist filter"
            name="artistId"
            value={artistId}
            initial={artists}
            onChange={setArtistId}
            describe={(x) => x.name}
            empty="All Artists"
          />
          <select
            aria-label="Label filter"
            name="labelId"
            defaultValue={filters.labelId ?? ""}
          >
            <option value="">All Labels</option>
            {labels.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </>
      )}
      <select
        aria-label="Status filter"
        name="status"
        defaultValue={filters.status ?? ""}
      >
        <option value="">All statuses</option>
        {["DRAFT", "SCHEDULED", "PUBLISHED", "UNPUBLISHED", "ARCHIVED"].map(
          (x) => (
            <option key={x}>{x}</option>
          ),
        )}
      </select>
      <button className="button">Filter</button>
    </form>
  );
}
