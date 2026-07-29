"use client";

import { useState, useTransition } from "react";
import { resolveExceptionCase, reviewCase } from "../../../lib/actions";

/**
 * The HITL gate (PROJECT_PLAN §2). A case sitting in `awaiting_review` blocks its workflow
 * until one of these three buttons fires a signal; a case in `exception` waits for a written
 * resolution, which also becomes an approved protocol version.
 *
 * Each action disables the panel while it runs — a double-fired approve would be harmless
 * (the workflow takes the first signal) but a pharmacist deserves to see that their click
 * landed rather than wondering and clicking again.
 */
export function ReviewPanel({
  workflowId,
  status,
  draft,
  alternatives,
  alternativesWithheld,
  confidence,
  unavailableReason,
}: {
  workflowId: string;
  status: string;
  draft: string;
  alternatives: string[];
  /**
   * The alternatives agent's own stated confidence, already formatted, or null when there is no
   * model estimate at all — a protocol reused from memory or written by a pharmacist has none, and
   * rendering that as 0% would attribute a human decision to the model at its least certain.
   */
  confidence: string | null;
  /** True when the compliance guard objected to the alternatives, so the list is empty by force. */
  alternativesWithheld?: boolean;
  /**
   * Why a decision cannot be taken by this caller, naming the role it needs, or null when it can.
   *
   * The controls still RENDER when this is set — disabled, with the reason attached. A control
   * that disappears teaches nobody what to ask for, and the server action refuses the decision
   * either way, so the label is a courtesy rather than the enforcement.
   */
  unavailableReason?: string | null;
}) {
  const blocked = Boolean(unavailableReason);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [editedDraft, setEditedDraft] = useState(draft);
  const [rejectReason, setRejectReason] = useState("");
  const [resolutionBody, setResolutionBody] = useState("");
  const [resolutionAlternative, setResolutionAlternative] = useState("");
  const [rationale, setRationale] = useState("");

  function run(action: () => Promise<void>) {
    setError(undefined);
    startTransition(async () => {
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  if (status === "awaiting_review") {
    const edited = editedDraft !== draft;
    return (
      <div className="card">
        <h2>Pharmacist review</h2>
        <p className="sub">
          This case is blocked on your decision. Alternatives proposed:{" "}
          {alternativesWithheld
            ? "withheld by the compliance guard"
            : alternatives.length > 0
              ? alternatives.join(", ")
              : "none"}
          {confidence ? ` · model confidence ${confidence}` : ""}
        </p>
        {unavailableReason ? (
          <p className="sub sub-tight" role="note">
            {unavailableReason}
          </p>
        ) : null}
        <textarea
          className="draft-input"
          rows={10}
          value={editedDraft}
          disabled={pending}
          onChange={(event) => {
            setEditedDraft(event.target.value);
          }}
        />
        <div className="actions">
          <button
            type="button"
            // `aria-disabled` rather than `disabled` when the caller lacks the role: a disabled
            // control leaves the tab order, taking the explanation of WHY with it. The handler
            // no-ops, and the server action refuses it regardless.
            aria-disabled={blocked || undefined}
            title={unavailableReason ?? undefined}
            disabled={pending}
            onClick={() => {
              if (blocked) return;
              run(() =>
                reviewCase(
                  workflowId,
                  edited ? { kind: "edit", editedDraft } : { kind: "approve" },
                ),
              );
            }}
          >
            {edited ? "Approve with edits" : "Approve"}
          </button>
          <input
            className="reason-input"
            placeholder="Reason (required to reject)"
            value={rejectReason}
            disabled={pending}
            onChange={(event) => {
              setRejectReason(event.target.value);
            }}
          />
          <button
            type="button"
            className="danger"
            aria-disabled={blocked || undefined}
            title={unavailableReason ?? undefined}
            disabled={pending || rejectReason.trim().length === 0}
            onClick={() => {
              if (blocked) return;
              run(() => reviewCase(workflowId, { kind: "reject", reason: rejectReason.trim() }));
            }}
          >
            Reject
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    );
  }

  if (status === "exception") {
    return (
      <div className="card">
        <h2>Resolve exception</h2>
        <p className="sub">
          The agent escalated this case. What you write here becomes an approved protocol version
          for this drug and releases the case — future shortages of it reuse your text.
          {confidence ? ` The agent's own confidence in its draft was ${confidence}.` : ""}
        </p>
        {unavailableReason ? (
          <p className="sub sub-tight" role="note">
            {unavailableReason}
          </p>
        ) : null}
        <textarea
          className="draft-input"
          rows={8}
          placeholder="Substitution or allocation guidance for the floor"
          value={resolutionBody}
          disabled={pending}
          onChange={(event) => {
            setResolutionBody(event.target.value);
          }}
        />
        <div className="actions">
          <input
            className="reason-input"
            placeholder="Alternative (optional)"
            value={resolutionAlternative}
            disabled={pending}
            onChange={(event) => {
              setResolutionAlternative(event.target.value);
            }}
          />
          <input
            className="reason-input"
            placeholder="Why (recorded on the protocol version)"
            value={rationale}
            disabled={pending}
            onChange={(event) => {
              setRationale(event.target.value);
            }}
          />
          <button
            type="button"
            aria-disabled={blocked || undefined}
            title={unavailableReason ?? undefined}
            disabled={
              pending || resolutionBody.trim().length === 0 || rationale.trim().length === 0
            }
            onClick={() => {
              if (blocked) return;
              run(() =>
                resolveExceptionCase(workflowId, {
                  protocolBody: resolutionBody.trim(),
                  alternatives: resolutionAlternative.trim() ? [resolutionAlternative.trim()] : [],
                  rationale: rationale.trim(),
                }),
              );
            }}
          >
            Resolve and write protocol
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    );
  }

  return null;
}
