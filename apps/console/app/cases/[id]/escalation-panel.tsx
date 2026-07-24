"use client";

import { useState, useTransition } from "react";
import type { EscalationEvent } from "@stopgap/workflows";
import { acknowledgeCase } from "../../lib/actions";
import { formatUtc } from "../../lib/format";

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
  escalationEvents,
  acked,
  ackError,
  acks,
  canAck,
}: {
  workflowId: string;
  escalationStep: number | undefined;
  escalationEvents: EscalationEvent[];
  acked: boolean;
  ackError: string | undefined;
  acks: AckRow[];
  canAck: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  // The ladder never ran (severity below high, or no policy) and nothing was acked — nothing to show.
  if (escalationStep === undefined && escalationEvents.length === 0 && acks.length === 0) return null;
  const notified = escalationEvents.filter((e) => !e.sendFailed);

  return (
    <div className="card">
      <h2>Escalation</h2>
      <p className="sub">
        {acked
          ? "Acknowledged — the ladder stopped."
          : notified.length > 0
            ? `Notified through tier ${String(notified[notified.length - 1]?.step ?? 0)} — awaiting acknowledgment.`
            : "Escalation pending."}
      </p>
      {/* An ack whose durable write failed rolled back to unacknowledged; say why, or the ack just
          appears to have vanished. */}
      {ackError ? (
        <p className="match-bad">
          Last acknowledgment could not be recorded and did not take effect: {ackError}
        </p>
      ) : null}
      <ol className="audit">
        {/* Each event carries its own tier: a failed send occupies a slot, so array position is
            not the tier number once one has failed. */}
        {escalationEvents.map((e) =>
          e.sendFailed ? (
            <li key={`tier-${String(e.step)}`} className="match-bad">
              <b>tier {e.step} send failed</b> · nobody was paged for this tier · {formatUtc(e.at)}
            </li>
          ) : (
            <li key={`tier-${String(e.step)}`}>
              <b>tier {e.step} notified</b> · {formatUtc(e.at)}
            </li>
          ),
        )}
        {acks.map((a) => (
          <li key={`ack-${String(a.step)}`}>
            <b>acknowledged</b> · tier {a.step} · {a.ackedByLabel} · {formatUtc(a.ackAt)}
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
