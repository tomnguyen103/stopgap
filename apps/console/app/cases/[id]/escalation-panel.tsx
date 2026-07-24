"use client";

import { useState, useTransition } from "react";
import { acknowledgeCase } from "../../lib/actions";

/**
 * The per-case escalation timeline + acknowledge control (PHASE6 §6.3). Shows the ladder as it
 * climbs — each tier the durable workflow notified, whether a human has acknowledged, and who —
 * and offers an Ack button that signals the workflow to stop the ladder.
 *
 * The button is a convenience only: `acknowledgeCase` re-checks the role server-side, so a viewer
 * (or the anonymous demo) who somehow reaches it still fails. `canAck` just hides a button that
 * would always fail for the current surface (demo mode), matching how the review panel is hidden.
 */
export interface AckRow {
  step: number;
  ackAt: string;
  ackedByLabel: string;
}

export function EscalationPanel({
  workflowId,
  escalationStep,
  escalatedAt,
  acked,
  acks,
  canAck,
}: {
  workflowId: string;
  escalationStep: number | undefined;
  escalatedAt: string[];
  acked: boolean;
  acks: AckRow[];
  canAck: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  // The ladder never ran (severity below high, or no policy) and nothing was acked — nothing to show.
  if (escalationStep === undefined && escalatedAt.length === 0 && acks.length === 0) return null;

  return (
    <div className="card">
      <h2>Escalation</h2>
      <p className="sub">
        {acked
          ? "Acknowledged — the ladder stopped."
          : escalatedAt.length > 0
            ? `Notified through tier ${String(escalationStep ?? 0)} — awaiting acknowledgment.`
            : "Escalation pending."}
      </p>
      <ol className="audit">
        {escalatedAt.map((ts, i) => (
          <li key={`notified-${String(i)}`}>
            <b>tier {i} notified</b> · {new Date(ts).toLocaleString()}
          </li>
        ))}
        {acks.map((a) => (
          <li key={`ack-${String(a.step)}`}>
            <b>acknowledged</b> · tier {a.step} · {a.ackedByLabel} · {new Date(a.ackAt).toLocaleString()}
          </li>
        ))}
      </ol>
      {canAck && !acked ? (
        <div className="actions">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(undefined);
              startTransition(async () => {
                try {
                  await acknowledgeCase(workflowId);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              });
            }}
          >
            Acknowledge
          </button>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
