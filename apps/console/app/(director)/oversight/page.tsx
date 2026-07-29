import Link from "next/link";
import { getEnv } from "@stopgap/core";

import { Badge, Card, Table } from "../../components/ui";
import { TrendChart } from "../../components/trend-chart";
import { getOversight, getShadowDashboard } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { diffLines, summarizeDiff } from "../../lib/version-diff";

export const dynamic = "force-dynamic";

/**
 * Director oversight — governance rather than individual cases (ticket 14).
 *
 * What a director is accountable for, on one page: what is waiting on them, how the facility is
 * trending, whether anyone answered the critical cases, what the system is spending, and whether
 * its judgement is good enough to trust with more autonomy.
 *
 * Guards itself, and does not rely on the group layout having run: a layout is not an authorization
 * boundary, because Next does not re-render one on a soft navigation and the partial render is
 * driven by router-state headers the client supplies.
 */
export default async function OversightPage() {
  await requireGroup("pharmacy_director");
  const [oversight, shadow] = await Promise.all([getOversight(), getShadowDashboard()]);
  const cap = getEnv().LLM_DAILY_USD_CAP;

  return (
    <>
      <h1>Oversight</h1>
      <p className="sub">Exposure across the facility, for the people accountable for it</p>

      <section className="ds-figures" aria-label="Headline figures">
        <Figure label="Open cases" value={oversight.kpis.openCases} />
        <Figure label="Awaiting approval" value={oversight.pendingVersions.length} />
        <Figure label="Unacknowledged critical" value={oversight.unacknowledged.length} />
        <Figure label="Exception queue" value={oversight.kpis.exceptionCases} />
      </section>

      <Card title="Fourteen days" sub="Cases opened and alerts fired, per day">
        {/* Over TIME, not only as current values: four open cases today is a different facility
            depending on whether last week held one or forty. */}
        <TrendChart series={oversight.trend} />
      </Card>

      <Card
        title="Waiting for your approval"
        sub={`${oversight.pendingVersions.length} drafted protocol version${
          oversight.pendingVersions.length === 1 ? "" : "s"
        }`}
      >
        {oversight.pendingVersions.length === 0 ? (
          <p className="sub sub-tight">Nothing is waiting on a director.</p>
        ) : (
          <Table
            label="Protocol versions awaiting approval"
            head={["Protocol", "Version", "Authored by", "What changed"]}
          >
            {oversight.pendingVersions.map(({ protocol, version, previousBody }) => (
              <tr key={version.id}>
                <td>
                  <Link href="/approvals">{protocol.title}</Link>
                </td>
                <td>v{version.version}</td>
                <td>{version.authoredBy}</td>
                <td className="sub">{summarizeDiff(diffLines(previousBody, version.body))}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="Unacknowledged critical cases"
        sub="How far the escalation ladder has run, and who has not answered it"
      >
        {oversight.unacknowledged.length === 0 ? (
          <p className="sub sub-tight">Every open critical case has been acknowledged.</p>
        ) : (
          <Table
            label="Critical cases with no acknowledgment"
            head={["Case", "Opened", "Ladder tier reached"]}
          >
            {oversight.unacknowledged.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/cases/${encodeURIComponent(row.workflowId)}`}>
                    {row.genericName}
                  </Link>{" "}
                  <Badge severity="critical">critical</Badge>
                </td>
                <td className="sub">{row.openedAt.toISOString().slice(0, 10)}</td>
                <td>
                  {row.escalationStep === null ? (
                    <span className="sub">not yet escalated</span>
                  ) : (
                    `tier ${String(row.escalationStep)}`
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Model spend" sub={`Today, ${oversight.spend.day}`}>
        <p>
          <strong>${oversight.spend.usd.toFixed(2)}</strong>
          <span className="sub">
            {" "}
            across {oversight.spend.calls} call{oversight.spend.calls === 1 ? "" : "s"}
          </span>
        </p>
        {cap === undefined ? (
          // "No cap" is a configuration, not a zero. Rendering a share of an absent cap would
          // invent a denominator and report a percentage of nothing.
          <p className="sub sub-tight">
            No daily cap is configured, so there is no share to report. Over a cap, routing would be
            restricted to the free local provider.
          </p>
        ) : (
          <p className="sub sub-tight">
            {((oversight.spend.usd / Math.max(cap, 0.01)) * 100).toFixed(0)}% of the $
            {cap.toFixed(2)} cap.
            {oversight.spend.usd >= cap
              ? " The cap is reached: model calls route to the local provider until it resets."
              : ""}
          </p>
        )}
      </Card>

      <Card title="Shadow agreement" sub="Measured per drug class, with the promotion gates">
        {shadow.length === 0 ? (
          <p className="sub sub-tight">
            No shadow runs recorded yet. Agreement is measured rather than assumed, so nothing is
            claimed here until there is something to measure.
          </p>
        ) : (
          <Table
            label="Shadow agreement by drug class"
            head={["Drug class", "Runs", "Mean agreement", "Under-called", "Stage", "Blocked by"]}
          >
            {shadow.map(({ stats, decision }) => (
              <tr key={stats.drugClass ?? "unclassified"}>
                <td>{stats.drugClass ?? <span className="sub">unclassified</span>}</td>
                <td>{stats.runs}</td>
                <td>{(stats.meanAgreement * 100).toFixed(0)}%</td>
                <td>{(stats.underEscalationRate * 100).toFixed(0)}%</td>
                <td>
                  <Badge tone="status">{decision.stage}</Badge>
                </td>
                <td className="sub">
                  {/* The criteria NOT met, named. "Not promoted" without the reason is a verdict a
                      director cannot act on. */}
                  {decision.blockedBy.length === 0 ? "every gate met" : decision.blockedBy.join("; ")}
                </td>
              </tr>
            ))}
          </Table>
        )}
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
