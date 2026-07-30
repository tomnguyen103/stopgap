"use client";

import { useState, useTransition } from "react";

import { approveProtocolVersionAction } from "../../lib/actions";

/**
 * Approve a drafted protocol version (ticket 14).
 *
 * Approving SUPERSEDES the version it replaces, in one transaction — see `approveProtocolVersion`.
 * The button says so, because "approve" and "supersede the current guidance" are the same act here
 * and a director should not have to know that from the schema.
 */
export function ApproveButton({
  versionId,
  supersedes,
  unavailableReason,
}: {
  versionId: string;
  /** The version this one would replace, when there is an approved one. */
  supersedes: number | null;
  /** Why this caller cannot approve, naming the role. Null when they can. */
  unavailableReason: string | null;
}) {
  const blocked = Boolean(unavailableReason);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  return (
    <>
      <button
        type="button"
        className="ds-button"
        // `aria-disabled`, not `disabled`: a disabled control leaves the tab order and takes its
        // own explanation with it. The handler no-ops and the server action refuses regardless.
        aria-disabled={blocked || undefined}
        // The reason belongs in the ACCESSIBLE NAME as well as the tooltip, the way
        // `components/role-gated.tsx` composes them: browsers do not fire `title` for a screen
        // reader, so a tooltip-only explanation reaches everyone except the people who most need
        // it. Composed with the control's own name rather than replacing it — a bare reason
        // announces why without saying which control it belongs to.
        title={unavailableReason ?? undefined}
        aria-label={unavailableReason ? `Approve — ${unavailableReason}` : undefined}
        disabled={pending}
        onClick={() => {
          if (blocked) return;
          setError(undefined);
          startTransition(async () => {
            try {
              await approveProtocolVersionAction(versionId);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          });
        }}
      >
        {pending
          ? "Approving…"
          : supersedes === null
            ? "Approve"
            : `Approve, superseding v${String(supersedes)}`}
      </button>
      {unavailableReason ? (
        <p className="sub sub-tight" role="note">
          {unavailableReason}
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
