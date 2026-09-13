export type MediaBrowseState = { view: "ACTIVE" | "RETIRED"; kind: "ALL" | "IMAGE" | "AUDIO"; page: number };

export function parseMediaBrowse(query: URLSearchParams): MediaBrowseState {
  const kind = query.get("kind");
  const page = Number(query.get("page"));
  return {
    view: query.get("view")?.toUpperCase() === "RETIRED" ? "RETIRED" : "ACTIVE",
    kind: kind === "IMAGE" || kind === "AUDIO" ? kind : "ALL",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function mediaBrowseQuery({ view, kind, page }: MediaBrowseState) {
  const query = new URLSearchParams();
  if (view === "RETIRED") query.set("view", "retired");
  if (kind !== "ALL") query.set("kind", kind);
  if (page > 1) query.set("page", String(page));
  return query;
}
