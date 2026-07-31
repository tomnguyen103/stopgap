"use client";

import { useState, useTransition } from "react";
import type { Role } from "@stopgap/core";
import { assignRoleAction, revokeRoleAction, setUserDisabledAction } from "../../../lib/actions";
import { Button, Card, Table, Toggle } from "../../../components/ui";

/**
 * Role management UI (PHASE6 §6.1). A thin client over the admin server actions — each role is a
 * toggle that grants or revokes. The server actions re-check `requireRole("manage_users")`, so
 * this UI never carries authority on its own; hiding controls is convenience, not the gate.
 */
interface AdminUser {
  id: string;
  label: string;
  roles: Role[];
  /** Soft-disabled. Only ever true when the caller asked to see disabled accounts. */
  disabled: boolean;
}

export function UsersAdmin({ users, allRoles }: { users: AdminUser[]; allRoles: Role[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

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

  if (users.length === 0) {
    return <div className="empty">No users yet — they appear here after their first sign-in.</div>;
  }

  return (
    <Card>
      <Table head={["User", "Roles", "Account"]} label="Users and their roles">
        {users.map((user) => (
          // A disabled account wears the rail, so it is findable in a mixed list before reading —
          // and the word "Disabled" in the last cell is what actually says so.
          <tr key={user.id} data-state={user.disabled ? "attention" : undefined}>
            <td>{user.label}</td>
            <td>
              <div className="actions">
                {allRoles.map((role) => {
                  const has = user.roles.includes(role);
                  return (
                    <Toggle
                      key={role}
                      pressed={has}
                      disabled={pending}
                      onClick={() => {
                        run(() =>
                          has ? revokeRoleAction(user.id, role) : assignRoleAction(user.id, role),
                        );
                      }}
                    >
                      {role}
                    </Toggle>
                  );
                })}
              </div>
            </td>
            <td>
              {user.disabled ? (
                <div className="actions">
                  <span className="sub">Disabled</span>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={pending}
                    onClick={() => {
                      run(() => setUserDisabledAction(user.id, false));
                    }}
                  >
                    Enable
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="danger"
                  disabled={pending}
                  onClick={() => {
                    run(() => setUserDisabledAction(user.id, true));
                  }}
                >
                  Disable
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
