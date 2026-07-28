import { getShadowDashboard, getShadowRuns } from "../lib/data";

export const dynamic = "force-dynamic";

/**
 * Shadow-mode agreement dashboard (PROJECT_PLAN §3A). Read-only: it shows what the agent
 * would have decided on the replay corpus and how often that matched the human baseline,
 * plus the promotion stage each drug class has earned and what is still blocking the next
 * one. Nothing here can promote a class — promotion is computed from the ledger, not set.
 */
export default async function ShadowPage() {
  const [classes, runs] = await Promise.all([getShadowDashboard(), getShadowRuns(50)]);
  const totalRuns = classes.reduce((sum, row) => sum + row.stats.runs, 0);

  return (
    <>
      <h1>Shadow mode</h1>
      <p className="sub">
        {totalRuns} scored run{totalRuns === 1 ? "" : "s"} · agent proposals vs the human
        baseline · no shadow run ever touches a live case
      </p>

      {classes.length === 0 ? (
        <div className="empty">
          No shadow runs yet. Replay the corpus:{" "}
          <code>pnpm --filter @stopgap/shadow replay</code>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Drug class</th>
              <th>Runs</th>
              <th>Agreement</th>
              <th>Severity match</th>
              <th>Under-escalation</th>
              <th>Stage</th>
              <th>Blocked by</th>
            </tr>
          </thead>
          <tbody>
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
          </tbody>
        </table>
      )}

      <h2>Recent runs</h2>
      {runs.length === 0 ? (
        <div className="empty">Nothing to triage yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Corpus case</th>
              <th>Proposed</th>
              <th>Baseline</th>
              <th>Agreement</th>
              <th>Latency</th>
              <th>Model</th>
            </tr>
          </thead>
          <tbody>
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
          </tbody>
        </table>
      )}
    </>
  );
}
