import { revealTiming } from "@/lib/reveal-timing";
import { RevealProbe } from "./reveal-probe";
import Link from "next/link";
import { actorForPage } from "@/lib/session";
import { headers } from "next/headers";
import { cataloguePage, filterOptions } from "@/modules/catalogue/reads";
import {
  listQuery,
  browseSchema,
  type CatalogueKind,
} from "@/modules/catalogue/browse";
import { formatCmsDate } from "@/lib/date";
import { formatDuration } from "@/modules/tracks/duration";
import { TracksFilters } from "./tracks-filters";
import "./cms-form-design.css";
import "./catalogue-list-design.css";
import { IntentLink } from "./intent-link";
export async function CatalogueList({
  kind,
  params,
}: {
  kind: CatalogueKind;
  params: Record<string, string | string[] | undefined>;
}) {
  const timing = revealTiming("cms_list_page");
  const actor = await actorForPage(await headers());
  timing.mark("sessionCompleteMs");
  const query = listQuery(params);
  const filters = browseSchema.parse(Object.fromEntries(query));
  timing.mark("serviceStartMs");
  const [data, options] = await Promise.all([
    cataloguePage(actor, kind, filters),
    kind === "artists"
      ? Promise.resolve({ artists: [], labels: [] })
      : filterOptions(actor, filters.artistId, filters.labelId),
  ]);
  timing.mark("serviceEndMs");
  const title = kind.charAt(0).toUpperCase() + kind.slice(1);
  const singular = title.slice(0, -1);
  const base = `/admin/${kind}`;
  const returnTo = base + (query.size ? `?${query}` : "");
  function pageUrl(page: number) {
    const q = new URLSearchParams(query);
    q.set("page", String(page));
    return `${base}?${q}`;
  }
  const FilterComponent = TracksFilters;
  const content = (
    <div className="cms-form-design cms-list-design">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Content</div>
          <h1>{title}</h1>
          <p className="muted">Browse and manage your catalogue.</p>
        </div>
        {actor.role !== "VIEWER" && (
          <Link className="button primary" href={`${base}/new`}>
            {`Create ${singular}`}
          </Link>
        )}
      </section>
      <FilterComponent
        key={query.toString()}
        kind={kind}
        filters={filters}
        artists={options.artists}
        labels={options.labels}
      />
      <nav aria-label="Catalogue pagination" className="cms-pagination">
        {data.page > 1 && (
          <IntentLink href={pageUrl(data.page - 1)}>Previous</IntentLink>
        )}
        <span role="status">
          Page {data.page} · {data.items.length} results
        </span>
        {data.hasMore && (
          <IntentLink href={pageUrl(data.page + 1)}>Next</IntentLink>
        )}
      </nav>
      <section
        className={`panel table-panel ${kind === "artists" ? "" : `${singular.toLowerCase()}-table`}`}
      >
        <div className="table-row table-head">
          <span>{singular}</span>
          {kind !== "artists" && (
            <>
              <span>Primary Artist</span>
              {kind !== "tracks" && <span>Date</span>}
              <span>Label</span>
            </>
          )}
          <span>Legacy ID</span>
          {kind === "tracks" && <span>Duration</span>}
          {kind === "podcasts" && <span>Chapters</span>}
          {kind === "releases" && <span>Tracks</span>}
          <span>Status</span>
          <span>{kind === "artists" ? "Version" : "Unpublished changes"}</span>
          <span>Updated</span>
        </div>
        {data.items.length === 0 && (
          <div className="empty">No {title} match these filters.</div>
        )}
        {data.items.map((row) => (
          <IntentLink
            className="table-row"
            key={row.id}
            href={`${base}/${row.id}?returnTo=${encodeURIComponent(returnTo)}`}
          >
            <span>
              <strong>{"name" in row ? row.name : row.title}</strong>
              {"slug" in row && <small>/{row.slug}</small>}
            </span>
            {"primaryArtist" in row && (
              <>
                <span data-label="Artist">{row.primaryArtist.name}</span>
                {"episodeDate" in row && (
                  <span data-label="Date">
                    {row.episodeDate?.toISOString().slice(0, 10) ?? "—"}
                  </span>
                )}
                {"releaseDate" in row && (
                  <span data-label="Date">
                    {row.releaseDate?.toISOString().slice(0, 10) ?? "—"}
                  </span>
                )}
                <span data-label="Label">{row.label.name}</span>
              </>
            )}
            <span data-label="Legacy ID">{row.legacyId}</span>
            {"durationMs" in row && (
              <span data-label="Duration">{formatDuration(row.durationMs) ?? "—"}</span>
            )}
            {"_count" in row && (
              <span data-label={kind === "podcasts" ? "Chapters" : "Tracks"}>
                {"chapters" in row._count
                  ? row._count.chapters
                  : row._count.tracks}
              </span>
            )}
            <span>
              <i className={`status ${row.status.toLowerCase()}`}>
                {row.status}
              </i>
            </span>
            <span data-label={kind === "artists" ? "Version" : "Unpublished changes"}>
              {"publishedRevision" in row
                ? !row.publishedRevision ||
                  row.publishedRevision.sourceWorkingVersion !==
                    row.workingVersion
                  ? "Yes"
                  : "No"
                : `v${row.workingVersion}`}
            </span>
            <span data-label="Updated">{formatCmsDate(row.updatedAt)}</span>
          </IntentLink>
        ))}
      </section>
      {process.env.CMS_REVEAL_TIMING === "1" && (kind === "artists" || kind === "podcasts") && <RevealProbe kind={kind} />}
    </div>
  );
  timing.mark("constructedMs");
  timing.finish();
  return content;
}
