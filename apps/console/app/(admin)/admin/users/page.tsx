import { ROLES } from "@stopgap/core";
import Link from "next/link";
import { getUsers } from "../../../lib/data";
import { isActionAllowed } from "../../../lib/authz";
import { resolvePrincipal } from "../../../lib/principal";
import { UsersAdmin } from "./users-admin";
import { requireGroup } from "../../../lib/group-guard";

export const dynamic = "force-dynamic";

/**
 * Admin user management (PHASE6 §6.1). Minimal by design: list active users with their roles,
 * and grant/revoke roles or disable an account. Gated to `admin` server-side — the check here is
 * defence in depth (the mutating actions each call `requireRole("manage_users")` independently),
 * so a non-admin who reaches the URL sees nothing actionable.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireGroup("admin");
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
  // In the ADDRESS, like every other list state in this console: the view an admin is looking at
  // is the view they can send to a colleague, and the back button behaves.
  const includeDisabled = (await searchParams).disabled === "1";
  const users = await getUsers({ includeDisabled });
  const active = users.filter((u) => u.disabledAt === null).length;
  return (
    <>
      <h1>Users</h1>
      <p className="sub">
        {active} active user{active === 1 ? "" : "s"} · roles gate every mutating action server-side
        (viewer &lt; pharmacist &lt; pharmacy_director &lt; admin)
      </p>
      <p>
        <Link
          className="ds-link"
          href={includeDisabled ? "/admin/users" : "/admin/users?disabled=1"}
        >
          {includeDisabled ? "Hide disabled accounts" : "Show disabled accounts"}
        </Link>
      </p>
      <UsersAdmin
        users={users.map((u) => ({
          id: u.id,
          label: u.displayName ?? u.email ?? u.oidcSubject ?? u.id,
          roles: u.roles,
          disabled: u.disabledAt !== null,
        }))}
        allRoles={[...ROLES]}
      />
    </>
  );
}
