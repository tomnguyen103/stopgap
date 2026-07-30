import Link from "next/link";

import { Badge, Card, Table } from "../../components/ui";
import { getSignalsPage, getViewerOverview } from "../../lib/data";
import { resolvePrincipal } from "../../lib/principal";
import { requireGroup } from "../../lib/group-guard";
import {
  bandSeverity,
  filterValue,
  pageCount,
  parseSignalListParams,
  partialScoreNotice,
  signalListHref,
  sortHref,
  toggleFilterHref,
  SIGNAL_LIST_SCHEMA,
} from "../../lib/signal-list";

export const dynamic = "force-dynamic";

/**
 * The viewer overview — the lowest-privilege surface and the public demo, which are one thing
 * (ticket 08).
 *
 * READ-ONLY BY CONSTRUCTION rather than by hiding controls: every interaction here is a GET back to
 * this route. No server action is imported and no form posts, so an anonymous visitor has nothing
 * to submit even with a hand-built request — a stronger statement than a disabled button.
 *
 * List state lives in the address, so the view a viewer is looking at is the view they can send to a
 * colleague, and a hand-edited address degrades to defaults instead of erroring: the parser is
 * total (`lib/list-params.ts`).
 *
 * Guards itself, and does not rely on the group layout having run. A layout is NOT an authorization
 * boundary: Next does not re-render one on a soft navigation, and the partial render is driven by
 * router-state headers the client supplies.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireGroup("viewer");
  const principal = await resolvePrincipal();
  const params = parseSignalListParams(await searchParams);
  const [overview, signals] = await Promise.all([
    // One search term narrows BOTH lists: story 17 asks to search "signals and cases by drug name
    // or identifier", and a term that quietly applied to one of them would leave a filtered list
    // beside an unfiltered one under a single search box.
    getViewerOverview(params.q),
    getSignalsPage({
      q: params.q,
      riskDomain: filterValue(params, "domain"),
      severity: filterValue(params, "severity"),
      freshness: filterValue(params, "freshness"),
      sort: params.sort,
      dir: params.dir,
      page: params.page,
      pageSize: params.pageSize,
    }),
  ]);
  const pages = pageCount(signals.total, params.pageSize);
  // The tenant's newest snapshot, not whichever ranked row happens to carry one: which components
  // the scorer can fill is a property of its inputs, and sampling a row makes the notice vanish the
  // moment that row is unscored.
  const notice = partialScoreNotice(overview.latestComponents);

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">
        Read-only supply picture · {principal.authenticated ? principal.label : "anonymous visitor"}
      </p>
      {notice ? (
        <p className="sub" role="note">
          {notice}
        </p>
      ) : null}

      <section className="ds-figures" aria-label="Headline figures">
        <Figure label="Open cases" value={overview.kpis.openCases} />
        <Figure label="Awaiting review" value={overview.awaitingReview} />
        <Figure label="Exception queue" value={overview.kpis.exceptionCases} />
      </section>

      <Card title="Ranked queue" sub="Open cases, highest risk score first">
        {overview.ranked.length === 0 ? (
          <p className="sub sub-tight">No open cases.</p>
        ) : (
          <Table
            label="Open cases ranked by risk score"
            head={["Case", "Status", "Score", "Band", "Breakdown"]}
          >
            {overview.ranked.map((row) => (
              <tr key={row.id}>
                <td>{row.genericName}</td>
                <td>{row.status.replace(/_/g, " ")}</td>
                <td>
                  {row.score === null ? (
                    <span className="sub">not scored</span>
                  ) : (
                    <>
                      {row.score.toFixed(1)}
                      <span className="sub"> / {row.reachableMax ?? 100}</span>
                    </>
                  )}
                </td>
                <td>
                  {row.band ? <Badge severity={bandSeverity(row.band)}>{row.band}</Badge> : "—"}
                </td>
                <td>
                  {/* Where the rank came from. A number with no way to reach its components is the
                      "trust me" this ticket exists to refuse. */}
                  {row.signalKey ? (
                    <Link href={"/signals/" + encodeURIComponent(row.signalKey)}>components</Link>
                  ) : (
                    <span className="sub">no signal names this product</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Signals" sub={`${signals.total} in this facility's feed`}>
        {/* GET, so a search is a link a viewer can share and the back button behaves. */}
        <form className="ds-filters" method="get" role="search">
          <label className="sub" htmlFor="signal-q">
            Search by drug name or identifier
          </label>
          <input
            className="ds-input"
            id="signal-q"
            name="q"
            type="search"
            defaultValue={params.q ?? ""}
            placeholder="heparin, 0409-1234-56 …"
          />
          {/* Filters AND sort survive the search. Without these the form drops both, so searching
              from a sorted, filtered view silently widens and reorders it. */}
          {Object.entries(params.filters).flatMap(([key, values]) =>
            values.map((value) => (
              <input key={`${key}:${value}`} type="hidden" name={key} value={value} />
            )),
          )}
          <input type="hidden" name="sort" value={params.sort} />
          <input type="hidden" name="dir" value={params.dir} />
          <input type="hidden" name="pageSize" value={String(params.pageSize)} />
          <button className="ds-button" type="submit">
            Search
          </button>
        </form>

        {Object.entries(SIGNAL_LIST_SCHEMA.filters).map(([key, allowed]) => (
          <div className="ds-chips" key={key}>
            <span className="sub">{key}</span>
            {allowed.map((value) => {
              const active = (params.filters[key] ?? []).includes(value);
              return (
                <Link
                  key={value}
                  className={active ? "ds-chip ds-chip--on" : "ds-chip"}
                  href={toggleFilterHref(params, key, value)}
                  /* A link is not a button: aria-pressed is not valid on role=link, and what is
                     being announced is "this is the view you are on". */
                  aria-current={active ? "true" : undefined}
                >
                  {value}
                </Link>
              );
            })}
          </div>
        ))}

        {signals.rows.length === 0 ? (
          <p className="sub sub-tight">
            No signals match this view. <Link href="?">Clear filters</Link>
          </p>
        ) : (
          <Table
            label="Risk signals"
            head={[
              <SortLink key="entity" params={params} sortKey="entity" label="Product" />,
              "Source",
              "Domain",
              <SortLink key="severity" params={params} sortKey="severity" label="Severity" />,
              <SortLink key="published" params={params} sortKey="published" label="Published" />,
              "Freshness",
              "Score",
            ]}
          >
            {signals.rows.map(({ signal, score }) => (
              <tr key={signal.id}>
                <td>
                  <Link href={`/signals/${encodeURIComponent(signal.dedupeKey)}`}>
                    {signal.entityIdentifier}
                  </Link>
                  <div className="sub">{signal.title}</div>
                </td>
                <td>{signal.source.replace(/_/g, " ")}</td>
                <td>{signal.riskDomain}</td>
                <td>
                  <Badge severity={bandSeverity(signal.severity)}>{signal.severity}</Badge>
                </td>
                <td>{signal.publishedAt.toISOString().slice(0, 10)}</td>
                <td>
                  {signal.staleness}
                  {signal.sourceResolved ? <span className="sub"> · source resolved</span> : null}
                </td>
                <td>{score ? score.score.toFixed(1) : <span className="sub">—</span>}</td>
              </tr>
            ))}
          </Table>
        )}

        <nav className="ds-pager" aria-label="Signal pages">
          {/* At the end of the range the control is not a link at all. aria-disabled on an anchor
              still navigates from the keyboard — a control that says one thing to a screen reader
              and does another. The page shown is the one the query CLAMPED to, so a bookmarked
              ?page=500 reports the page it actually rendered. */}
          {signals.page > 1 ? (
            <Link
              className="ds-button ds-button--quiet"
              href={signalListHref(params, { page: signals.page - 1 })}
            >
              Previous
            </Link>
          ) : (
            <span className="ds-button ds-button--quiet is-inert">Previous</span>
          )}
          <span className="sub">
            Page {signals.page} of {pages}
          </span>
          {signals.page < pages ? (
            <Link
              className="ds-button ds-button--quiet"
              href={signalListHref(params, { page: signals.page + 1 })}
            >
              Next
            </Link>
          ) : (
            <span className="ds-button ds-button--quiet is-inert">Next</span>
          )}
        </nav>
      </Card>
    </>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="ds-figure">
      <div className="ds-figure__value">{value}</div>
      <div className="sub">{label}</div>
    </div>
  );
}

function SortLink({
  params,
  sortKey,
  label,
}: {
  params: ReturnType<typeof parseSignalListParams>;
  sortKey: string;
  label: string;
}) {
  const active = params.sort === sortKey;
  return (
    <Link href={sortHref(params, sortKey)}>
      {label}
      {active ? <span aria-hidden="true">{params.dir === "asc" ? " ↑" : " ↓"}</span> : null}
    </Link>
  );
}
