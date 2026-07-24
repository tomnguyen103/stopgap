"use client";

import { useState, useTransition } from "react";
import { resolveExceptionCase, reviewCase } from "../../lib/actions";

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
}: {
  workflowId: string;
  status: string;
  draft: string;
  alternatives: string[];
}) {
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
          {alternatives.length > 0 ? alternatives.join(", ") : "none"}
        </p>
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
            disabled={pending}
            onClick={() => {
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
            disabled={pending || rejectReason.trim().length === 0}
            onClick={() => {
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
          The agent escalated this case. What you write here becomes an approved protocol
          version for this drug and releases the case — future shortages of it reuse your text.
        </p>
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
            disabled={pending || resolutionBody.trim().length === 0 || rationale.trim().length === 0}
            onClick={() => {
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
