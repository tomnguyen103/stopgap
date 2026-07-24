import { getKpis } from "@stopgap/db";
import { getShadowDashboard } from "../lib/data";

export const dynamic = "force-dynamic";

function pct(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

/**
 * KPI dashboard (PROJECT_PLAN §14). Targets are shown next to the measurement so a number
 * that looks fine in isolation can still read as failing, and any metric with no data yet
 * says so rather than rendering a confident zero.
 */
export default async function MetricsPage() {
  const [kpis, shadow] = await Promise.all([getKpis(), getShadowDashboard()]);
  const worstUnderEscalation = shadow.reduce(
    (worst, row) => Math.max(worst, row.stats.underEscalationRate),
    0,
  );

  const rows: { metric: string; value: string; target: string; note: string }[] = [
    {
      metric: "Time to approved protocol (median)",
      value:
        kpis.medianHoursToApproval === undefined
          ? "—"
          : `${kpis.medianHoursToApproval.toFixed(1)} h`,
      target: "< 1 h machine + review latency",
      note: "Manual baseline is days. Measured from case.detected to case.approved in the audit trail.",
    },
    {
      metric: "Draft acceptance (unedited)",
      value: pct(kpis.draftAcceptanceRate),
      target: "≥ 80%",
      note: `${kpis.reviewedCases} reviewed case${kpis.reviewedCases === 1 ? "" : "s"}. An edit counts against acceptance.`,
    },
    {
      metric: "Under-escalation (worst drug class)",
      value: shadow.length === 0 ? "—" : pct(worstUnderEscalation),
      target: "≈ 0",
      note: "Shadow runs where the agent called a shortage less severe than the human baseline.",
    },
    {
      metric: "Dropped cases",
      value: String(kpis.droppedCases),
      target: "0",
      note: "Open cases with no state change in 90 days — every shortage must reach a terminal state.",
    },
    {
      metric: "Exception queue",
      value: String(kpis.exceptionCases),
      target: "—",
      note: "Cases waiting on a pharmacist. Not a failure: escalation is the designed behaviour.",
    },
  ];

  return (
    <>
      <h1>KPIs</h1>
      <p className="sub">
        {kpis.totalCases} case{kpis.totalCases === 1 ? "" : "s"} · {kpis.openCases} open ·{" "}
        {kpis.terminalCases} closed or rejected
      </p>

      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Now</th>
            <th>Target</th>
            <th>What it means</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric}>
              <td>{row.metric}</td>
              <td className="status">{row.value}</td>
              <td>{row.target}</td>
              <td className="sub">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
