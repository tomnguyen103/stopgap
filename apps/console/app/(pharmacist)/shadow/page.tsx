import { getShadowDashboard, getShadowRuns } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { Table } from "../../components/ui/table";

export const dynamic = "force-dynamic";

/**
 * Shadow-mode agreement dashboard (PROJECT_PLAN §3A). Read-only: it shows what the agent
 * would have decided on the replay corpus and how often that matched the human baseline,
 * plus the promotion stage each drug class has earned and what is still blocking the next
 * one. Nothing here can promote a class — promotion is computed from the ledger, not set.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function ShadowPage() {
  await requireGroup("pharmacist");
  const [classes, runs] = await Promise.all([getShadowDashboard(), getShadowRuns(50)]);
  const totalRuns = classes.reduce((sum, row) => sum + row.stats.runs, 0);

  return (
    <>
      <h1>Shadow mode</h1>
      <p className="sub">
        {totalRuns} scored run{totalRuns === 1 ? "" : "s"} · agent proposals vs the human baseline ·
        no shadow run ever touches a live case
      </p>

      {classes.length === 0 ? (
        <div className="empty">
          No shadow runs yet. Replay the corpus: <code>pnpm --filter @stopgap/shadow replay</code>
        </div>
      ) : (
        <Table
          head={[
            "Drug class",
            "Runs",
            "Agreement",
            "Severity match",
            "Under-escalation",
            "Stage",
            "Blocked by",
          ]}
          label="Shadow-mode agreement by day"
        >
          {classes.map(({ stats, decision }) => (
            <tr key={stats.drugClass ?? "unclassified"}>
              <td>{stats.drugClass ?? "unclassified"}</td>
              <td>{stats.runs}</td>
              <td>{(stats.meanAgreement * 100).toFixed(0)}%</td>
              <td>{(stats.severityAgreementRate * 100).toFixed(0)}%</td>
              <td>{(stats.underEscalationRate * 100).toFixed(0)}%</td>
              <td className="status">{decision.stage}</td>
              <td className="sub">{decision.blockedBy.join("; ") || "—"}</td>
            </tr>
          ))}
        </Table>
      )}

      <h2>Recent runs</h2>
      {runs.length === 0 ? (
        <div className="empty">Nothing to triage yet.</div>
      ) : (
        <Table
          head={["Corpus case", "Proposed", "Baseline", "Agreement", "Latency", "Model"]}
          label="Shadow-mode disagreements"
        >
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{run.corpusId}</td>
              <td>
                <span className={`pill sev-${run.proposedSeverity}`}>{run.proposedSeverity}</span>{" "}
                {run.proposedAlternatives.length} alt
              </td>
              <td>
                <span className={`pill sev-${run.baselineSeverity}`}>{run.baselineSeverity}</span>{" "}
                {run.baselineAlternatives.length} alt
              </td>
              <td>{(Number(run.agreement) * 100).toFixed(0)}%</td>
              <td>{run.latencyMs} ms</td>
              <td className="sub">{run.modelId}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
