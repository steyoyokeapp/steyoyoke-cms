"use client";
import { useEffect, useState } from "react";
type Entry = {
  id: string;
  createdAt: string;
  title?: string;
  revisionNumber?: number;
  sourceWorkingVersion?: number;
  action?: string;
  actorName?: string;
};
export function SecondarySections({
  kind,
  id,
  version,
}: {
  kind: string;
  id: string;
  version: number;
}) {
  return (
    <aside className="preview-column" key={`${id}:${version}`}>
      <LazySection
        kind={kind}
        id={id}
        section="preview"
        title="Preview / Compatibility JSON"
      />
      <LazySection
        kind={kind}
        id={id}
        section="history"
        title="Revision history"
      />
      <LazySection kind={kind} id={id} section="audit" title="Audit trail" />
    </aside>
  );
}
function LazySection({
  kind,
  id,
  section,
  title,
}: {
  kind: string;
  id: string;
  section: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<unknown>(null);
  const [rows, setRows] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [snapshotId, setSnapshotId] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      setBusy(true);
      try {
        const response = await fetch(
          `/api/admin/secondary?${new URLSearchParams({ kind, id, section, page: String(page) })}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error?.message ?? "Could not load section.");
        if (active) {
          setError("");
          if (section === "preview") setData(body);
          else {
            setRows((current) =>
              page === 1
                ? body.items
                : [
                    ...current,
                    ...body.items.filter(
                      (x: Entry) => !current.some((y) => y.id === x.id),
                    ),
                  ],
            );
            setMore(body.hasMore);
          }
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Could not load section.");
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [kind, id, section, open, page]);
  return (
    <section className="panel history-panel">
      <h2>
        <button
          type="button"
          className="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {title}
        </button>
      </h2>
      {open && (
        <>
          {section === "preview" && data !== null && (
            <>
              <p className="muted">
                Saved record preview. Save draft changes before comparing
                delivery JSON.
              </p>
              <pre data-testid="canonical-preview">
                {JSON.stringify(
                  (data as { canonical: unknown }).canonical,
                  null,
                  2,
                )}
              </pre>
              <pre
                data-testid={
                  kind === "releases"
                    ? "legacy-release-preview"
                    : "legacy-preview"
                }
              >
                {JSON.stringify((data as { legacy: unknown }).legacy, null, 2)}
              </pre>
              {kind === "releases" && (
                <pre data-testid="releasecomplete-preview">
                  {JSON.stringify(
                    (data as { releasecomplete: unknown }).releasecomplete,
                    null,
                    2,
                  )}
                </pre>
              )}
            </>
          )}
          {rows.map((x) => (
            <div className="history-row" key={x.id}>
              <strong>
                {x.revisionNumber ? `r${x.revisionNumber}` : x.action}
              </strong>
              <span>{x.title ?? x.actorName ?? "Scheduler"}</span>
              <time>{new Date(x.createdAt).toLocaleString()}</time>
              {x.revisionNumber && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setSnapshotId(x.id)}
                >
                  View snapshot r{x.revisionNumber}
                </button>
              )}
            </div>
          ))}
          {snapshotId && (
            <Snapshot kind={kind} id={id} revisionId={snapshotId} />
          )}{" "}
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Loading {title}…</p>}
          {more && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setPage(page + 1)}
            >
              Load more
            </button>
          )}
        </>
      )}
    </section>
  );
}
function Snapshot({
  kind,
  id,
  revisionId,
}: {
  kind: string;
  id: string;
  revisionId: string;
}) {
  const [data, setData] = useState<{ id: string; body: unknown } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    void fetch(
      `/api/admin/secondary?${new URLSearchParams({ kind, id, section: "snapshot", revisionId })}`,
      { cache: "no-store", signal: c.signal },
    )
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok)
          throw new Error(body.error?.message ?? "Could not load snapshot.");
        if (!c.signal.aborted) setData({ id: revisionId, body });
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [kind, id, revisionId]);
  return error ? (
    <p role="alert">{error}</p>
  ) : data?.id === revisionId ? (
    <pre>{JSON.stringify(data.body, null, 2)}</pre>
  ) : (
    <p role="status">Loading snapshot…</p>
  );
}
