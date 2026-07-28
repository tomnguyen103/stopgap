import Link from "next/link";
import { getActiveOrgOverride } from "./lib/principal";

/**
 * "You are acting inside <hospital>" (PHASE6 §6.5).
 *
 * The admin active-org switch is a real privilege — read AND write access to another tenant's
 * clinical data — and until this badge existed the console gave no indication it was in effect.
 * Every page rendered the other hospital's cases exactly the way it renders your own. The realistic
 * accident is not an attacker: it is an admin who switched on Tuesday, forgot, and approves a
 * substitution protocol into the wrong facility on Thursday, with the audit chain faithfully
 * recording a correct-looking action in a tenant nobody meant to touch.
 *
 * So it renders ONLY when the active org differs from the signed-in user's own, and it renders
 * prominently. A badge that is always present is a badge nobody reads; a badge that appears only in
 * the elevated state is a state indicator. It links to the switcher so returning is one click, and
 * it is paired with a one-hour cookie lifetime (`ACTIVE_ORG_COOKIE_MAX_AGE_SECONDS`) so the state
 * also ends on its own if the admin simply walks away.
 *
 * An async server component: it reads the session and the cookie, both of which are per-request, so
 * every route that renders the root layout becomes dynamic. That is the cost of showing the truth
 * about the current request, and it is the correct trade for a control this consequential.
 */
export async function ActiveOrgBadge() {
  const active = await getActiveOrgOverride();
  if (!active) return null;
  return (
    <Link
      href="/admin/organizations"
      className="active-org-badge"
      title="Switch back to your own organization"
    >
      <span className="active-org-badge__label">Acting in</span>
      <strong className="active-org-badge__name">{active.name}</strong>
      <span className="active-org-badge__slug">{active.slug}</span>
    </Link>
  );
}
