import Link from "next/link";
import { getEnv } from "@stopgap/core";
import { ladderPosition } from "@stopgap/workflows";

import { Sparkline } from "../../components/sparkline";
import { TrendChart } from "../../components/trend-chart";
import { getOversight, getShadowDashboard } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { diffLines, summarizeDiff } from "../../lib/version-diff";
import { Badge, Card, Table } from "../../components/ui";

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
  /**
   * The rungs elapsed time has already passed, as a sentence.
   *
   * Says so plainly when no ladder is configured for `critical`, rather than leaving a cell that
   * reads as "nothing is owed yet" — the opposite of what an unconfigured policy means.
   */
  const ladderFor = (minutesOpen: number) => {
    if (oversight.criticalLadder.length === 0) return "no ladder configured for critical";
    const { reached, next } = ladderPosition(oversight.criticalLadder, minutesOpen);
    const owed =
      reached.length === 0
        ? "no rung due yet"
        : `${reached.map((step) => step.notify).join(", ")} should know`;
    return next === null ? `${owed} · ladder exhausted` : `${owed} · next ${next.notify}`;
  };
  const cap = getEnv().LLM_DAILY_USD_CAP;

  return (
    <>
      <h1>Oversight</h1>
      <p className="sub">Exposure across the facility, for the people accountable for it</p>

      <section className="ds-figures" aria-label="Headline figures">
        <Figure
          label="Open cases"
          value={oversight.kpis.openCases}
          // The sparkline is `casesOpened` per day — a FLOW under a LEVEL, which is why it carries
          // its own label rather than being left to read as the figure's own history.
          spark={oversight.trend.map((day) => day.casesOpened)}
          sparkLabel="opened per day, 14 days"
        />
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
        // Amber when something is waiting on this director, a hairline when nothing is. A card
        // that is always tinted reports nothing.
        state={oversight.pendingVersions.length > 0 ? "attention" : "ok"}
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
                <td className="is-subtle">
                  {summarizeDiff(diffLines(previousBody, version.body))}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        // Critical, not amber: an unanswered critical case is the most serious thing this page
        // can report, and it is the reason a director opens it.
        state={oversight.unacknowledged.length > 0 ? "critical" : "ok"}
        title="Unacknowledged critical cases"
        sub="Critical cases the escalation ladder has not got an answer for"
      >
        {oversight.unacknowledged.length === 0 ? (
          <p className="sub sub-tight">Every open critical case has been acknowledged.</p>
        ) : (
          <Table
            label="Critical cases with no acknowledgment"
            head={["Case", "Opened", "Unanswered for", "Ladder reached"]}
          >
            {oversight.unacknowledged.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/cases/${encodeURIComponent(row.workflowId)}`}>
                    {row.genericName}
                  </Link>{" "}
                  <Badge severity="critical">critical</Badge>
                </td>
                <td className="is-subtle">{row.openedAt.toISOString().slice(0, 10)}</td>
                <td>
                  {row.hoursOpen < 24
                    ? `${String(row.hoursOpen)} hour${row.hoursOpen === 1 ? "" : "s"}`
                    : `${String(Math.floor(row.hoursOpen / 24))} day${row.hoursOpen < 48 ? "" : "s"}`}
                </td>
                <td className="is-subtle">
                  {/* WHO THE POLICY HAS ALREADY CALLED FOR, read from elapsed time. Every row here
                      comes off an anti-join and has no acknowledgment at all, so a tier taken from
                      `acknowledgments` would read "not yet escalated" for all of them however long
                      they had burned — the one reading that cannot tell the case nobody has seen
                      for ten minutes from the one nobody has seen for ten hours. */}
                  {ladderFor(row.minutesOpen)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Deployment-wide, and labelled as such: `llm_spend` is one row per day for the whole
          deployment (see docs/multi-tenancy.md), so presenting it as this facility's spend would
          attribute every tenant's calls to whoever is reading. */}
      <Card title="Model spend" sub={`Deployment-wide, today (${oversight.spend.day})`}>
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
            {/* A cap of ZERO is configured, not absent — it means "spend nothing", and every call
                is over it. The old `Math.max(cap, 0.01)` floor turned that into a percentage of a
                denominator nobody set: $3 against a $0 cap printed "30000%", which reads as a
                display bug and buries the one fact that matters, that the cap is reached. */}
            {cap === 0
              ? "The cap is $0.00, so any spend is over it."
              : `${((oversight.spend.usd / cap) * 100).toFixed(0)}% of the $${cap.toFixed(2)} cap.`}
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
                <td className="is-subtle">
                  {/* EVERY gate for the stage this class is working towards, met and unmet alike,
                      with the reading behind each. Naming only the failures answers "why not yet"
                      and nothing else: a class one gate short reads the same as one that is four
                      short, and a class that has just cleared its hardest gate looks no different
                      from one that never had it. The two questions a director actually has are how
                      close this is and which gate to work on, and both need the passes visible. */}
                  {decision.criteria.length === 0 ? (
                    "at the top stage — no further gates"
                  ) : (
                    <ul className="ds-gates">
                      {decision.criteria.map((c) => (
                        <li key={c.label} data-met={c.met ? "yes" : "no"}>
                          <span aria-hidden="true">{c.met ? "✓" : "✗"}</span>{" "}
                          <span className="ds-sr-only">{c.met ? "met:" : "not met:"}</span>
                          {c.label} {c.actual} ({c.required})
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

/**
 * The second-order mark (§6): the number gets the largest type on the page and the label sits
 * beneath it in Micro uppercase — not a 28px figure over a 13px sentence, which reads as a caption
 * under a heading rather than as a measurement.
 */
function Figure({
  label,
  value,
  spark,
  sparkLabel,
}: {
  label: string;
  value: number;
  /** A 14-day series, when one exists for this figure. */
  spark?: number[];
  /** Names which series the sparkline draws — it is rarely the figure's own history. */
  sparkLabel?: string;
}) {
  return (
    <div className="ds-figure">
      <div className="ds-figure__value">{value}</div>
      <div className="ds-figure__label">{label}</div>
      {spark && sparkLabel ? (
        <>
          <Sparkline points={spark} label={sparkLabel} />
          <p className="ds-figure__target">{sparkLabel}</p>
        </>
      ) : null}
    </div>
  );
}
