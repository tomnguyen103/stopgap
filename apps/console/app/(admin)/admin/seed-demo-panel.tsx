"use client";

import { useState, useTransition } from "react";
import type { Role } from "@stopgap/core";
import { seedDemoWorkspaceAction } from "../../lib/actions";
import { RoleGatedButton } from "../../components/role-gated";

/**
 * Seed the demo workspace (ticket 17).
 *
 * Rendered whether or not this deployment is in demo mode, and that is the useful part: on a real
 * install the control is present and says why it will not run, which answers "can I get a
 * demo workspace here" without anyone having to read the seeder's source to find out.
 *
 * The button is not the gate. `seedDemoWorkspaceAction` refuses a caller without `manage_demo_config`
 * and refuses any deployment not in demo mode, whatever this renders.
 */
export function SeedDemoPanel({ roles, demoMode }: { roles: readonly Role[]; demoMode: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <>
      <p className="sub sub-tight">
        {demoMode
          ? "Writes three invented shortages and their protocol history, keyed `demo-seed-`. Idempotent — re-running updates rather than duplicating."
          : "Unavailable: this deployment is not in demo mode. Seeding here would put invented shortages beside real ones in the review queue."}
      </p>
      <div className="actions">
        <RoleGatedButton
          roles={roles}
          requires="admin"
          // NOT `disabled`, which `RoleGatedButton` deliberately does not accept: a disabled
          // control leaves the tab order and takes its explanation with it. Outside demo mode the
          // button stays pressable and the ACTION refuses, with the reason — the same "the label is
          // not the gate" stance every other control here takes.
          state={pending ? "loading" : undefined}
          onClick={() => {
            setError(undefined);
            setResult(undefined);
            startTransition(async () => {
              try {
                const seeded = await seedDemoWorkspaceAction();
                setResult(
                  `Seeded ${String(seeded.cases)} case${seeded.cases === 1 ? "" : "s"} and ${String(seeded.protocols)} protocol version${seeded.protocols === 1 ? "" : "s"}.`,
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            });
          }}
        >
          Seed demo workspace
        </RoleGatedButton>
      </div>
      {result ? (
        <p className="sub" role="status">
          {result}
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
