"use client";

import { useTransition } from "react";
import type { Role } from "@stopgap/core";
import { approveProtocolVersionAction } from "../../lib/actions";
import { RoleGatedButton } from "../../components/role-gated";

/**
 * Approve a drafted protocol version (ticket 03's disabled-control behaviour, made reachable).
 *
 * Rendered for every version still in draft, whoever is looking. A pharmacist sees it DISABLED and
 * told what it takes — the point of `RoleGatedButton`: hiding it would teach them the button is
 * broken rather than that approval is the director's call.
 *
 * The label is not the gate. `approveProtocolVersionAction` calls `requireRole` server-side and
 * refuses a hand-crafted request whatever this renders.
 */
export function ApproveVersionButton({
  versionId,
  roles,
}: {
  versionId: string;
  roles: readonly Role[];
}) {
  const [pending, startTransition] = useTransition();
  return (
    <RoleGatedButton
      roles={roles}
      requires="pharmacy_director"
      state={pending ? "loading" : undefined}
      onClick={() => {
        startTransition(async () => {
          await approveProtocolVersionAction(versionId);
        });
      }}
    >
      Approve
    </RoleGatedButton>
  );
}
