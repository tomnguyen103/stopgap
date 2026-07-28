import { ROLES } from "@stopgap/core";
import { getUsers } from "../../../lib/data";
import { isActionAllowed } from "../../../lib/authz";
import { resolvePrincipal } from "../../../lib/principal";
import { UsersAdmin } from "./users-admin";

export const dynamic = "force-dynamic";

/**
 * Admin user management (PHASE6 §6.1). Minimal by design: list active users with their roles,
 * and grant/revoke roles or disable an account. Gated to `admin` server-side — the check here is
 * defence in depth (the mutating actions each call `requireRole("manage_users")` independently),
 * so a non-admin who reaches the URL sees nothing actionable.
 */
export default async function AdminUsersPage() {
  const principal = await resolvePrincipal();
  const allowed = isActionAllowed(principal.roles, "manage_users");
  if (!allowed) {
    return (
      <>
        <h1>Users</h1>
        <div className="empty">
          Admin only. Your roles: [{principal.roles.join(", ") || "none"}].
        </div>
      </>
    );
  }
  const users = await getUsers();
  return (
    <>
      <h1>Users</h1>
      <p className="sub">
        {users.length} active user{users.length === 1 ? "" : "s"} · roles gate every mutating
        action server-side (viewer &lt; pharmacist &lt; pharmacy_director &lt; admin)
      </p>
      <UsersAdmin
        users={users.map((u) => ({
          id: u.id,
          label: u.displayName ?? u.email ?? u.oidcSubject ?? u.id,
          roles: u.roles,
        }))}
        allRoles={[...ROLES]}
      />
    </>
  );
}
