"use client";

import { useState, useTransition } from "react";
import type { Role } from "@stopgap/core";
import { supersedeProtocolVersionAction } from "../../lib/actions";
import { RoleGatedButton } from "../../components/role-gated";

/**
 * Withdraw the APPROVED version of a protocol, putting nothing in its place (ticket 14).
 *
 * The other half of "approved or superseded". Approving supersedes the previous version on the way
 * past, so the protocol always has live guidance; this leaves it with none — which is the right
 * answer when what we published turns out to be wrong or the shortage it addressed is over, and
 * the replacement has not been written yet. Stale guidance outliving its shortage is worse than an
 * empty protocol that says so.
 *
 * Rendered for whoever is looking, disabled for anyone below director, for the same reason
 * `ApproveVersionButton` is: hiding it teaches a pharmacist the control is broken rather than that
 * withdrawal is the director's call. Gated identically to approval, because taking live clinical
 * guidance down is at least as consequential as putting it up.
 *
 * A CONFIRM STEP, unlike approval. Approving is additive and reversible by approving the next
 * version; this removes the guidance the floor is reading right now, and a misclick would do it
 * silently. The second click is the whole safeguard — the server refuses nothing extra.
 */
export function WithdrawVersionButton({
  versionId,
  version,
  roles,
}: {
  versionId: string;
  version: number;
  roles: readonly Role[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <RoleGatedButton
        roles={roles}
        requires="pharmacy_director"
        variant="danger"
        state={pending ? "loading" : undefined}
        onClick={() => {
          setError(undefined);
          if (!confirming) {
            setConfirming(true);
            return;
          }
          startTransition(async () => {
            try {
              await supersedeProtocolVersionAction(versionId);
              setConfirming(false);
            } catch (err) {
              // The action refuses a caller without the role, and refuses a version that is a
              // draft rather than live guidance. Both are answers a reader needs, not unhandled
              // rejections.
              setError(err instanceof Error ? err.message : String(err));
              setConfirming(false);
            }
          });
        }}
      >
        {confirming ? `Confirm withdrawing v${String(version)}` : "Withdraw"}
      </RoleGatedButton>
      {confirming ? (
        <p className="sub" role="status">
          This leaves the protocol with no approved version until a new one is written.
        </p>
      ) : null}
      {error ? (
        <p className="sub" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
