"use client";

import { useState, useTransition } from "react";
import type { Role } from "@stopgap/core";
import { Toggle } from "../../../components/ui/toggle";
import { assignRoleAction, revokeRoleAction, setUserDisabledAction } from "../../../lib/actions";

/**
 * Role management UI (PHASE6 §6.1). A thin client over the admin server actions — each role is a
 * toggle that grants or revokes. The server actions re-check `requireRole("manage_users")`, so
 * this UI never carries authority on its own; hiding controls is convenience, not the gate.
 */
interface AdminUser {
  id: string;
  label: string;
  roles: Role[];
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
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Roles</th>
            <th>Account</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
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
                <button
                  type="button"
                  className="danger"
                  disabled={pending}
                  onClick={() => {
                    run(() => setUserDisabledAction(user.id, true));
                  }}
                >
                  Disable
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
