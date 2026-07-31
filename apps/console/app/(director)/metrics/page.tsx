import { getKpis, withOrgDb } from "@stopgap/db";
import { getShadowDashboard } from "../../lib/data";
import { resolvePrincipal } from "../../lib/principal";
import { requireGroup } from "../../lib/group-guard";
import { Card, type CardState } from "../../components/ui";

export const dynamic = "force-dynamic";

/** How a verdict tints its tile's Ledger Rail. `unknown` gets no rail: it is not a failure. */
const VERDICT_STATE: Record<string, CardState | undefined> = {
  met: "ok",
  missed: "critical",
  unknown: undefined,
  none: undefined,
};

/** The same verdict in words, because colour never carries meaning alone. */
const VERDICT_LABEL: Record<string, string> = {
  met: "met",
  missed: "missed",
  unknown: "not enough data yet",
  none: "",
};

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

  /**
   * A KPI, and whether it is being met.
   *
   * `verdict` is DERIVED from the number beside it, never written by hand, and it is deliberately
   * three-valued. A metric with no data yet is `unknown` — not `missed` — because rendering "no
   * reviewed cases yet" as a failed target invents a denominator the deployment does not have,
   * and a director acting on that would be acting on nothing.
   */
  const rows: {
    metric: string;
    value: string;
    target: string;
    verdict: "met" | "missed" | "unknown" | "none";
    note: string;
  }[] = [
    {
      metric: "Time to approved protocol (median)",
      value:
        kpis.medianHoursToApproval === undefined
          ? "—"
          : `${kpis.medianHoursToApproval.toFixed(1)} h`,
      target: "< 1 h machine + review latency",
      verdict:
        kpis.medianHoursToApproval === undefined
          ? "unknown"
          : kpis.medianHoursToApproval < 1
            ? "met"
            : "missed",
      note: "Manual baseline is days. Measured from case.detected to case.approved in the audit trail.",
    },
    {
      metric: "Draft acceptance (unedited)",
      value: pct(kpis.draftAcceptanceRate),
      target: "≥ 80%",
      verdict:
        kpis.draftAcceptanceRate === undefined
          ? "unknown"
          : kpis.draftAcceptanceRate >= 0.8
            ? "met"
            : "missed",
      note: `${kpis.reviewedCases} reviewed case${kpis.reviewedCases === 1 ? "" : "s"}. An edit counts against acceptance.`,
    },
    {
      metric: "Under-escalation (worst drug class)",
      value: shadow.length === 0 ? "—" : pct(worstUnderEscalation),
      target: "≈ 0",
      verdict: shadow.length === 0 ? "unknown" : worstUnderEscalation === 0 ? "met" : "missed",
      note: "Shadow runs where the agent called a shortage less severe than the human baseline.",
    },
    {
      metric: "Dropped cases",
      value: String(kpis.droppedCases),
      target: "0",
      verdict: kpis.droppedCases === 0 ? "met" : "missed",
      note: "Open cases with no state change in 90 days — every shortage must reach a terminal state.",
    },
    {
      metric: "Exception queue",
      value: String(kpis.exceptionCases),
      target: "—",
      // No target, so no verdict. A card with a rail here would claim a judgement nobody made.
      verdict: "none",
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

      {/*
        Figure tiles, not a four-column table. A KPI dashboard whose numbers are table cells makes
        the target column and the measurement column the same size, so nothing on the page is the
        headline — and the number IS the headline. Display-32 tabular, label beneath in Micro.
      */}
      <div className="ds-figures">
        {rows.map((row) => (
          <Card key={row.metric} state={VERDICT_STATE[row.verdict]} className="ds-figure">
            <p className="ds-figure__value">{row.value}</p>
            <p className="ds-figure__label">{row.metric}</p>
            <p className="ds-figure__target">
              Target {row.target}
              {/* The verdict in WORDS as well as in the rail's colour. The rail is what a director
                  finds scanning; this is what tells them, and a colourblind reader, which it is. */}
              {row.verdict === "none" ? null : (
                <>
                  {" · "}
                  <b>{VERDICT_LABEL[row.verdict]}</b>
                </>
              )}
            </p>
            <p className="sub sub-tight">{row.note}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
