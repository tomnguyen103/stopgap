"use client";

import { useState, useTransition } from "react";
import { setActiveOrgAction } from "../../../lib/actions";

/**
 * The admin active-org switch (PHASE6 §6.5) — a thin client over `setActiveOrgAction`.
 *
 * THIS COMPONENT CARRIES NO AUTHORITY. The action re-checks `requireRole("manage_users")`, verifies
 * the organization exists, and appends an audit entry, all server-side; rendering this list only
 * for admins is convenience. A non-admin who calls the action directly is refused there, and a
 * non-admin whose browser holds an active-org cookie has it ignored by `resolvePrincipal` — the
 * cookie is only ever consulted for a caller who holds `admin`.
 */
interface OrgOption {
  id: string;
  slug: string;
  name: string;
}

export function OrgSwitcher({ orgs, activeOrgId }: { orgs: OrgOption[]; activeOrgId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function switchTo(orgId: string) {
    setError(undefined);
    startTransition(async () => {
      try {
        await setActiveOrgAction(orgId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="card">
      {error ? <p className="sub">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Organization</th>
            <th>Slug</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {orgs.map((org) => {
            const active = org.id === activeOrgId;
            return (
              <tr key={org.id}>
                <td>{org.name}</td>
                <td className="sub">{org.slug}</td>
                <td>
                  {active ? (
                    <span className="status">current</span>
                  ) : (
                    <button type="button" disabled={pending} onClick={() => switchTo(org.id)}>
                      Act in this organization
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
