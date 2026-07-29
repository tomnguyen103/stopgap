import Link from "next/link";
import { isDemoMode } from "@stopgap/demo";

import { Badge, Card, Table } from "../../components/ui";
import { isActionAllowed } from "../../lib/authz";
import { unavailableReason } from "../../lib/case-queue";
import { getAlertHistory, getAlertRules } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { filterValue, listHref, pageCount, toggleFilterHref } from "../../lib/list-href";
import { parseListParams, type ListParamsSchema } from "../../lib/list-params";
import { resolvePrincipal } from "../../lib/principal";
import { RulesPanel } from "./rules-panel";

export const dynamic = "force-dynamic";

/**
 * Alert history's list state, in the address like every other list in this console.
 *
 * `outcome` is the alert pipeline's own vocabulary. A value this schema allowed but the column
 * never held would be a filter that returns nothing forever.
 */
const HISTORY_SCHEMA: ListParamsSchema = {
  sortKeys: ["fired"],
  defaultSort: "fired",
  defaultDir: "desc",
  filters: { outcome: ["fired", "suppressed", "failed"] },
  pageSizes: [25, 50],
  defaultPageSize: 25,
};

/**
 * Alert rules and the history they produced (ticket 14).
 *
 * Rules are tuned HERE rather than in a config file because the person who knows a rule is too
 * noisy is the director being paged by it, and a tuning that needs a deployment is a tuning that
 * does not happen.
 */
export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireGroup("pharmacy_director");
  const params = parseListParams(await searchParams, HISTORY_SCHEMA);
  const [rules, history, principal] = await Promise.all([
    getAlertRules(),
    getAlertHistory({
      outcome: filterValue(params, "outcome"),
      page: params.page,
      pageSize: params.pageSize,
    }),
    resolvePrincipal(),
  ]);
  const pages = pageCount(history.total, params.pageSize);
  const reason = unavailableReason(
    isActionAllowed(principal.roles, "manage_alert_rules"),
    "pharmacy_director",
    isDemoMode(),
  );

  return (
    <>
      <h1>Alerts</h1>
      <p className="sub">
        {rules.length} rule{rules.length === 1 ? "" : "s"} · {history.total} event
        {history.total === 1 ? "" : "s"} recorded
      </p>

      <Card title="Rules" sub="Who is told, about what, and how often">
        <RulesPanel
          rules={rules.map((rule) => ({
            id: rule.id,
            name: rule.name,
            enabled: rule.enabled,
            minSeverity: rule.minSeverity,
            cooldownMinutes: rule.cooldownMinutes,
            channels: rule.channels,
            riskDomain: rule.riskDomain,
            entityContains: rule.entityContains,
            // Formatted on the server: `toLocaleString()` in a client component reads a locale and
            // a time zone that differ between the render and the hydration.
            lastFired: null,
          }))}
          unavailableReason={reason}
        />
      </Card>

      <Card title="History" sub="Every firing, and every one that was suppressed or failed">
        <div className="ds-chips">
          <span className="sub">outcome</span>
          {HISTORY_SCHEMA.filters.outcome?.map((value) => {
            const active = (params.filters.outcome ?? []).includes(value);
            return (
              <Link
                key={value}
                className={active ? "ds-chip ds-chip--on" : "ds-chip"}
                href={toggleFilterHref(params, "outcome", value, HISTORY_SCHEMA)}
                aria-current={active ? "true" : undefined}
              >
                {value}
              </Link>
            );
          })}
        </div>

        {history.rows.length === 0 ? (
          <p className="sub sub-tight">
            No alert events match this view. <Link href="?">Clear filters</Link>
          </p>
        ) : (
          <Table
            label="Alert history"
            head={["Fired", "Rule", "Outcome", "Matched", "Delivered"]}
          >
            {history.rows.map(({ event, ruleName }) => (
              <tr key={event.id}>
                <td className="sub">{event.firedAt.toISOString().replace("T", " ").slice(0, 16)}</td>
                <td>{ruleName ?? <span className="sub">deleted rule</span>}</td>
                <td>
                  {event.outcome === "failed" ? (
                    <Badge severity="critical">failed</Badge>
                  ) : event.outcome === "suppressed" ? (
                    <Badge severity="moderate">suppressed</Badge>
                  ) : (
                    <Badge tone="status">fired</Badge>
                  )}
                </td>
                <td>{event.matchedCount}</td>
                <td>
                  {/* Delivery, not intent: an alert that reached nobody did not happen, and the
                      cooldown reads this column for exactly that reason. */}
                  {event.deliveredAny ? "yes" : <span className="sub">no</span>}
                </td>
              </tr>
            ))}
          </Table>
        )}

        <nav className="ds-pager" aria-label="History pages">
          {history.page > 1 ? (
            <Link
              className="ds-button ds-button--quiet"
              href={listHref(params, { page: history.page - 1 }, HISTORY_SCHEMA)}
            >
              Previous
            </Link>
          ) : (
            <span className="ds-button ds-button--quiet is-inert">Previous</span>
          )}
          <span className="sub">
            Page {history.page} of {pages}
          </span>
          {history.page < pages ? (
            <Link
              className="ds-button ds-button--quiet"
              href={listHref(params, { page: history.page + 1 }, HISTORY_SCHEMA)}
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
