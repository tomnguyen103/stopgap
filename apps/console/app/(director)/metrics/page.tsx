import { getKpis, withOrgDb } from "@stopgap/db";
import { getShadowDashboard } from "../../lib/data";
import { resolvePrincipal } from "../../lib/principal";
import { requireGroup } from "../../lib/group-guard";
import { Table } from "../../components/ui";

export const dynamic = "force-dynamic";

function pct(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

/**
 * KPI dashboard (PROJECT_PLAN §14). Targets are shown next to the measurement so a number
 * that looks fine in isolation can still read as failing, and any metric with no data yet
 * says so rather than rendering a confident zero.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function MetricsPage() {
  await requireGroup("pharmacy_director");
  // The caller's org (PHASE6 §6.5): KPIs are one hospital's operational performance, and averaging
  // two tenants' medians into one number would describe neither of them.
  const { orgId } = await resolvePrincipal();
  const [kpis, shadow] = await Promise.all([
    withOrgDb(orgId, (db) => getKpis(orgId, db)),
    getShadowDashboard(),
  ]);
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

      <Table
        head={["Metric", "Now", "Target", "What it means"]}
        label="Programme metrics against target"
      >
        {rows.map((row) => (
          <tr key={row.metric}>
            <td>{row.metric}</td>
            <td className="is-status">{row.value}</td>
            <td>{row.target}</td>
            <td className="is-subtle">{row.note}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
