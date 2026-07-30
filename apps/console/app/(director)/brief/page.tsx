import { DEGRADED_REASONS, type DegradedReason } from "@stopgap/db";
import { getDailyBriefs } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";

export const dynamic = "force-dynamic";

/**
 * The daily brief (ticket 13). Read-only: the schedule writes briefs, the console shows them.
 *
 * A DEGRADED BRIEF IS RENDERED AS DEGRADED, not hidden. "Nothing happened today" and "we could not
 * write today's brief" call for different responses from a director, and a page that shows only
 * the good ones makes the two indistinguishable.
 */
/**
 * A reason the writer minted but this page does not know is a deployment mid-rollout, not a
 * mystery — render the raw value rather than nothing.
 */
function degradedLabel(reason: string): string {
  return DEGRADED_REASONS[reason as DegradedReason] ?? reason;
}

export default async function BriefPage() {
  // The page guards ITSELF, like every other page in every group. The group layout's guard is not
  // the authorization boundary: a crafted router-state header makes React skip the layout and
  // render this page alone, which is the bypass the route-group work verified and fixed on all
  // thirteen pages that existed then. This page arrived in the group afterwards, by being moved
  // here, so it has to state the same guard rather than inherit one.
  await requireGroup("pharmacy_director");
  const briefs = await getDailyBriefs(30);
  const [latest, ...earlier] = briefs;

  return (
    <>
      <h1>Daily brief</h1>
      <p className="sub">
        What moved, what is newly at risk, and what needs review · generated on a schedule, one per
        day · every figure comes from the deterministic scorer, never from the model
      </p>

      {!latest ? (
        <div className="empty">
          No brief yet. The <code>daily-brief</code> schedule writes one per tenant per day.
        </div>
      ) : (
        <>
          <h2>
            {latest.briefDate}
            {latest.degradedReason ? (
              <>
                {" "}
                <span className="pill sev-high">{degradedLabel(latest.degradedReason)}</span>
              </>
            ) : null}
          </h2>
          <p>{latest.headline}</p>

          <h3>What changed</h3>
          {latest.changes.length === 0 ? (
            <div className="empty">Nothing recorded.</div>
          ) : (
            <ul>
              {latest.changes.map((line: string, i: number) => (
                <li key={`change-${String(i)}`}>{line}</li>
              ))}
            </ul>
          )}

          <h3>Newly at risk</h3>
          {latest.newlyAtRisk.length === 0 ? (
            <div className="empty">Nothing recorded.</div>
          ) : (
            <ul>
              {latest.newlyAtRisk.map((line: string, i: number) => (
                <li key={`risk-${String(i)}`}>{line}</li>
              ))}
            </ul>
          )}

          <h3>Needs review</h3>
          {latest.needsReview.length === 0 ? (
            <div className="empty">Nothing waiting on a human.</div>
          ) : (
            <ul>
              {latest.needsReview.map((line: string, i: number) => (
                <li key={`review-${String(i)}`}>{line}</li>
              ))}
            </ul>
          )}

          <p className="sub">
            {latest.signalKeys.length} signal{latest.signalKeys.length === 1 ? "" : "s"} in scope ·
            written by {latest.model ?? "no model"} ·{" "}
            {latest.generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC
          </p>
        </>
      )}

      {earlier.length > 0 && (
        <>
          <h2>Earlier</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Headline</th>
                <th>Signals</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {earlier.map((brief) => (
                <tr key={brief.id}>
                  <td>{brief.briefDate}</td>
                  <td>
                    {brief.degradedReason ? (
                      <span className="pill sev-high">
                        {degradedLabel(brief.degradedReason)}
                      </span>
                    ) : (
                      brief.headline
                    )}
                  </td>
                  <td>{brief.signalKeys.length}</td>
                  <td className="sub">{brief.model ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
