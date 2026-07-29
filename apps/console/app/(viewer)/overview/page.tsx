import Link from "next/link";

import { Badge, Card, Table, type Severity } from "../../components/ui";
import { getSignalsPage, getViewerOverview } from "../../lib/data";
import { resolvePrincipal } from "../../lib/principal";
import { requireGroup } from "../../lib/group-guard";
import {
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
    getViewerOverview(),
    getSignalsPage({
      q: params.q,
      riskDomain: params.filters.domain?.[0],
      severity: params.filters.severity?.[0],
      freshness: params.filters.freshness?.[0],
      sort: params.sort,
      dir: params.dir,
      page: params.page,
      pageSize: params.pageSize,
    }),
  ]);
  const pages = pageCount(signals.total, params.pageSize);
  // Read off a real snapshot rather than a constant: the notice disappears on its own once the
  // catalog slice lands and the scorer starts filling those components.
  const scored = overview.ranked.find((row) => row.components !== null);
  const notice = partialScoreNotice(scored?.components ?? null);

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">
        Read-only supply picture · {principal.authenticated ? principal.label : "anonymous visitor"}
      </p>

      <section className="ds-figures" aria-label="Headline figures">
        <Figure label="Open cases" value={overview.kpis.openCases} />
        <Figure label="Awaiting review" value={overview.awaitingReview} />
        <Figure label="Exception queue" value={overview.kpis.exceptionCases} />
      </section>

      <Card title="Ranked queue" sub="Open cases, highest risk score first">
        {overview.ranked.length === 0 ? (
          <p className="sub sub-tight">No open cases.</p>
        ) : (
          <Table label="Open cases ranked by risk score" head={["Case", "Status", "Score", "Band"]}>
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
              </tr>
            ))}
          </Table>
        )}
        {notice ? (
          <p className="sub sub-tight" role="note">
            {notice}
          </p>
        ) : null}
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
          {/* Filters already applied survive the search; without these it silently widens the view. */}
          {Object.entries(params.filters).flatMap(([key, values]) =>
            values.map((value) => (
              <input key={`${key}:${value}`} type="hidden" name={key} value={value} />
            )),
          )}
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
                  aria-pressed={active}
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
          <Link
            className="ds-button ds-button--quiet"
            href={signalListHref(params, { page: Math.max(1, params.page - 1) })}
            aria-disabled={params.page === 1}
          >
            Previous
          </Link>
          <span className="sub">
            Page {params.page} of {pages}
          </span>
          <Link
            className="ds-button ds-button--quiet"
            href={signalListHref(params, { page: Math.min(pages, params.page + 1) })}
            aria-disabled={params.page >= pages}
          >
            Next
          </Link>
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

/** The scorer's bands and the console's severity ramp share names; anything else stays neutral. */
function bandSeverity(band: string): Severity {
  return band === "critical" || band === "high" || band === "moderate" || band === "low"
    ? band
    : "none";
}
