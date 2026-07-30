import { getOrganizations } from "../../../lib/data";
import { isActionAllowed } from "../../../lib/authz";
import { resolvePrincipal } from "../../../lib/principal";
import { OrgSwitcher } from "./org-switcher";
import { requireGroup } from "../../../lib/group-guard";

export const dynamic = "force-dynamic";

/**
 * Organizations, and the ADMIN ACTIVE-ORG SWITCH (PHASE6 §6.5).
 *
 * §6.5 asks for an "org picker for multi-org admins". Pass 1 decided one IdP subject is one `users`
 * row is one org, so ordinary users are single-org by construction and have nothing to pick — the
 * picker is therefore a DEPLOYMENT-ADMIN capability: an `admin` may act inside any tenant on this
 * deployment.
 *
 * That is a real privilege and the page says so out loud rather than presenting the switch as a
 * neutral view filter. Switching does not merely change what is displayed; every subsequent read
 * AND WRITE — approvals, key issuance, workflow signals — happens inside the selected tenant, and
 * every audit entry records the org it happened in. The enforcement is server-side in
 * `resolvePrincipal` (the cookie is consulted only for a caller holding `admin`, and only when it
 * names a real organization) and in `setActiveOrgAction` (`requireRole` + existence check + an
 * audit append before the cookie is set), so hiding this page from non-admins is convenience only.
 *
 * NOT MULTI-ORG MEMBERSHIP. A pharmacist who genuinely works at two facilities needs a
 * `user_organizations` join table with per-org role grants; this PR does not build that, and the
 * deferral is recorded under §6.5 in PHASE6-PLAN.md.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function AdminOrganizationsPage() {
  await requireGroup("admin");
  const principal = await resolvePrincipal();
  const allowed = isActionAllowed(principal.roles, "manage_users");
  if (!allowed) {
    return (
      <>
        <h1>Organizations</h1>
        <div className="empty">
          Admin only. Your roles: [{principal.roles.join(", ") || "none"}].
        </div>
      </>
    );
  }
  const orgs = await getOrganizations();
  return (
    <>
      <h1>Organizations</h1>
      <p className="sub">
        {orgs.length} tenant{orgs.length === 1 ? "" : "s"} · every case, protocol, shadow run and
        audit chain belongs to exactly one of them, enforced by Postgres row-level security
      </p>
      <p className="sub">
        Switching the active organization makes every subsequent read <em>and write</em> happen
        inside that tenant, and each action you take is recorded in that tenant&apos;s audit chain
        under your identity. This is a deployment-admin capability, not a view filter.
      </p>
      <OrgSwitcher
        orgs={orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name }))}
        activeOrgId={principal.orgId}
      />
    </>
  );
}
