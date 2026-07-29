import Link from "next/link";
import { DEMO_DRUGS, isDemoMode } from "@stopgap/demo";

import { Badge, Card, Table } from "../../components/ui";
import { DemoPanel } from "../../demo-panel";
import { getCaseQueue, getFeedFreshness } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { isException, parseCaseQueueParams, CASE_QUEUE_SCHEMA } from "../../lib/case-queue";
import { filterValue, listHref, pageCount, sortHref, toggleFilterHref } from "../../lib/list-href";
import { bandSeverity } from "../../lib/signal-list";

export const dynamic = "force-dynamic";

/**
 * The review queue — the pharmacist's landing route (ticket 03), ranked and filterable (ticket 11).
 *
 * RANKED BY RISK, not by age: the queue's job is to put the most consequential case first, and
 * "newest touched" answers a different question. The rank comes from the deterministic scorer's
 * latest snapshot for the signal naming the same product — never from a signal's own severity,
 * which is one feed's opinion rather than this facility's exposure.
 *
 * Every interaction is a GET carrying its state in the address, so a pharmacist can send a
 * colleague the exact slice of the queue they are asking about.
 *
 * Guards itself, and does not rely on the group layout having run: a layout is not an authorization
 * boundary, because Next does not re-render one on a soft navigation and the partial render is
 * driven by router-state headers the client supplies.
 */
export default async function CaseQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireGroup("pharmacist");
  const params = parseCaseQueueParams(await searchParams);
  const [queue, feeds] = await Promise.all([
    getCaseQueue({
      q: params.q,
      status: filterValue(params, "status"),
      severity: filterValue(params, "severity"),
      riskDomain: filterValue(params, "domain"),
      sort: params.sort,
      dir: params.dir,
      page: params.page,
      pageSize: params.pageSize,
    }),
    getFeedFreshness(),
  ]);
  const pages = pageCount(queue.total, params.pageSize);

  return (
    <>
      {isDemoMode() ? (
        <DemoPanel drugs={DEMO_DRUGS.map((d) => ({ key: d.key, genericName: d.genericName }))} />
      ) : null}

      <h1>Review queue</h1>
      <p className="sub">
        {queue.total} open case{queue.total === 1 ? "" : "s"} · ranked by risk score, highest first
      </p>

      <Card title="Feeds" sub="What the ranking is reading">
        {feeds.length === 0 ? (
          // Absence is the honest reading: no stored record means no feed has returned data to
          // this deployment yet (ASHP without a key never does).
          <p className="sub sub-tight">No feed data stored yet — run the poll schedule.</p>
        ) : (
          <p className="sub sub-tight">
            {feeds.map((f) => (
              <span key={f.source} className="feed-line">
                <b>{f.source}</b> · latest stored record{" "}
                {new Date(f.lastFetchedAt).toLocaleString()} · {f.records} record
                {f.records === 1 ? "" : "s"}
              </span>
            ))}
          </p>
        )}
      </Card>

      <Card title="Cases" sub="Search, filter and sort — the view is in the address">
        <form className="ds-filters" method="get" role="search">
          <label className="sub" htmlFor="case-q">
            Search by drug name
          </label>
          <input
            className="ds-input"
            id="case-q"
            name="q"
            type="search"
            defaultValue={params.q ?? ""}
            placeholder="heparin …"
          />
          {/* Filters and sort survive the search; without these the form silently widens and
              reorders the view a pharmacist was working in. */}
          {Object.entries(params.filters).flatMap(([key, values]) =>
            values.map((value) => (
              <input key={`${key}:${value}`} type="hidden" name={key} value={value} />
            )),
          )}
          <input type="hidden" name="sort" value={params.sort} />
          <input type="hidden" name="dir" value={params.dir} />
          <button className="ds-button" type="submit">
            Search
          </button>
        </form>

        {Object.entries(CASE_QUEUE_SCHEMA.filters).map(([key, allowed]) => (
          <div className="ds-chips" key={key}>
            <span className="sub">{key}</span>
            {allowed.map((value) => {
              const active = (params.filters[key] ?? []).includes(value);
              return (
                <Link
                  key={value}
                  className={active ? "ds-chip ds-chip--on" : "ds-chip"}
                  href={toggleFilterHref(params, key, value, CASE_QUEUE_SCHEMA)}
                  aria-current={active ? "true" : undefined}
                >
                  {value.replace(/_/g, " ")}
                </Link>
              );
            })}
          </div>
        ))}

        {queue.rows.length === 0 ? (
          <p className="sub sub-tight">
            No open case matches this view. <Link href="?">Clear filters</Link>
          </p>
        ) : (
          <Table
            label="Open cases, ranked by risk score"
            head={[
              <Link key="entity" href={sortHref(params, "entity", CASE_QUEUE_SCHEMA)}>
                Drug
              </Link>,
              "Status",
              <Link key="severity" href={sortHref(params, "severity", CASE_QUEUE_SCHEMA)}>
                Severity
              </Link>,
              "Domain",
              <Link key="score" href={sortHref(params, "score", CASE_QUEUE_SCHEMA)}>
                Score
              </Link>,
              <Link key="updated" href={sortHref(params, "updated", CASE_QUEUE_SCHEMA)}>
                Updated
              </Link>,
            ]}
          >
            {queue.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/cases/${encodeURIComponent(row.workflowId)}`}>{row.genericName}</Link>
                </td>
                <td>
                  {isException(row.status) ? (
                    // The exception queue is a STATUS, not a second list: a case the workflow
                    // routed there for low confidence must not read as a confident draft.
                    <Badge severity="high">exception</Badge>
                  ) : (
                    row.status.replace(/_/g, " ")
                  )}
                </td>
                <td>
                  {row.severity ? (
                    <Badge severity={bandSeverity(row.severity)}>{row.severity}</Badge>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </td>
                <td>{row.riskDomain ?? <span className="sub">unclassified</span>}</td>
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
                <td className="sub">{row.updatedAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </Table>
        )}

        <nav className="ds-pager" aria-label="Queue pages">
          {/* A control at the end of the range is a span, not an aria-disabled anchor a keyboard
              still follows. The page shown is the one the query clamped to. */}
          {queue.page > 1 ? (
            <Link
              className="ds-button ds-button--quiet"
              href={listHref(params, { page: queue.page - 1 }, CASE_QUEUE_SCHEMA)}
            >
              Previous
            </Link>
          ) : (
            <span className="ds-button ds-button--quiet is-inert">Previous</span>
          )}
          <span className="sub">
            Page {queue.page} of {pages}
          </span>
          {queue.page < pages ? (
            <Link
              className="ds-button ds-button--quiet"
              href={listHref(params, { page: queue.page + 1 }, CASE_QUEUE_SCHEMA)}
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
