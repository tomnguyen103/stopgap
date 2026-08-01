import "server-only";
import { cookies } from "next/headers";
import { authConfigured, getEnv, type Role } from "@stopgap/core";
import { SEED_ORG_ID, getOrganization } from "@stopgap/db";
import { auth } from "../../auth";
import { rolesAllow } from "./authz";

/**
 * Who is making this request (PHASE6 §6.1). Isolated in its own module so `auth-guards` and the
 * server actions depend on THIS, and tests can mock the session read without loading NextAuth or
 * the DB. `userId` is a real `users.id` for an authenticated caller, `null` for the anonymous
 * viewer (the public demo, or any unauthenticated request — which then fails every mutation gate).
 */
export interface Principal {
  userId: string | null;
  /** Human label for the audit chain's text `actor` field — email, name, or a sentinel. */
  label: string;
  roles: Role[];
  authenticated: boolean;
  /**
   * The tenant this request acts in (PHASE6 §6.5). Every DB call the request makes is scoped to
   * it through `withOrgDb`, and every audit entry it writes records it — so "which hospital did
   * this happen in" is answerable from the chain rather than inferred from context.
   *
   * For an ordinary caller this is their own `users.orgId` and nothing can change it. For an
   * admin it may be the active-org switch below, which is a real privilege and is why it is
   * admin-gated and audited.
   */
  orgId: string;
}

/**
 * Cookie carrying an ADMIN's active organization (PHASE6 §6.5, "org picker for multi-org admins").
 *
 * WHAT THIS IS, STATED PLAINLY. Pass 1 decided that one IdP subject is one `users` row is one org,
 * so an ordinary user is single-org BY CONSTRUCTION and has nothing to pick between. The picker
 * §6.5 asks for is therefore implemented as a DEPLOYMENT-ADMIN capability: a holder of the `admin`
 * role can act inside any tenant on the deployment. That is a genuine privilege — read AND write
 * access to another hospital's clinical data — and it is gated and recorded accordingly: the
 * switch is refused for anyone below `admin`, refused for an id that is not a real organization,
 * and every audit entry the request writes carries the org actually acted in, so the chain shows
 * exactly which tenant an admin operated inside and when.
 *
 * WHAT IT IS NOT. It is not multi-org membership. A genuine multi-org *pharmacist* — one clinician
 * who legitimately works at two facilities — needs a `user_organizations` join table, per-org role
 * grants, and a picker limited to the orgs they are actually a member of. This PR does not build
 * that and does not pretend to: an admin switch and a membership model answer different questions,
 * and shipping the first while calling it the second would leave a deployment believing it had
 * per-user tenancy limits that do not exist. The deferral is recorded under §6.5 in PHASE6-PLAN.md.
 */
export const ACTIVE_ORG_COOKIE = "stopgap_active_org";

/**
 * How long an admin's active-org switch survives (PHASE6 §6.5). One hour.
 *
 * The elevated state has to expire on its own, because nothing else ends it. A switch made last
 * week is still in force today, and every clinical action taken since — a protocol approval, an
 * exception resolution — landed in the other hospital's data and its audit chain. That is not a bug
 * anyone would report: each individual action succeeded and was recorded correctly, in the wrong
 * tenant. An hour is long enough for a real cross-tenant task and short enough that it cannot
 * outlive the reason for it; re-switching is one click.
 */
export const ACTIVE_ORG_COOKIE_MAX_AGE_SECONDS = 60 * 60;

/**
 * Resolve the current principal from the Auth.js session, falling back to the anonymous viewer.
 * No session means the caller is a `viewer`: in demo mode that is the intended read-only guest;
 * outside demo it is an unauthenticated request that middleware either rejects (unconfigured) or
 * redirects (configured) — either way `viewer` holds no mutating role, so the guards refuse it.
 *
 * THE ORG IS RESOLVED SERVER-SIDE, ALWAYS (PHASE6 §6.5). The precedence is:
 *
 *  1. the signed-in user's own `session.user.orgId` (their `users.orgId`) — the default, and the
 *     only possible outcome for anyone who is not an admin;
 *  2. the active-org cookie, but ONLY when the caller holds `admin` AND the value names a real
 *     organization. Both checks happen HERE, on the server. A cookie is client-controlled state,
 *     so treating it as authoritative would hand a tenant-selection primitive to anyone who can
 *     set a header — the entire isolation model defeated by one `document.cookie`. A non-admin's
 *     cookie is ignored silently rather than rejected, because it is not an error condition: that
 *     user has exactly one org and that is the one they get;
 *  3. `SEED_ORG_ID` for the anonymous/demo viewer. The public demo IS the seed tenant — the org
 *     migration 0013 backfilled every pre-multi-tenancy row into, and the one the demo seeder
 *     fills — so this is a statement of fact rather than a fallback. Demo mode stays read-only
 *     through the existing gates, so a visitor gets exactly the seed org's data and no ability to
 *     change it.
 */
export async function resolvePrincipal(): Promise<Principal> {
  const session = authConfigured(getEnv()) ? await auth() : null;
  if (session?.user?.id) {
    const roles = session.user.roles ?? [];
    return {
      userId: session.user.id,
      label: session.user.email ?? session.user.name ?? session.user.id,
      roles,
      authenticated: true,
      orgId: await resolveActiveOrg(roles, session.user.orgId),
    };
  }
  return {
    userId: null,
    label: getEnv().STOPGAP_DEMO_MODE === "on" ? "demo-viewer" : "anonymous",
    roles: ["viewer"],
    authenticated: false,
    // The demo viewer is a guest OF the seed tenant, not of "no tenant". An unscoped principal
    // would be fail-closed (every query returns nothing) but would also make the public demo an
    // empty shell, so the org is named explicitly rather than left undefined.
    orgId: SEED_ORG_ID,
  };
}

/**
 * A uuid in the exact textual form Postgres will cast — the same check `withOrgDb` applies, for the
 * same reason and one layer earlier.
 *
 * `organizations.id` is a `uuid` COLUMN, so a cookie value that is not one does not come back as
 * "no such organization": Postgres raises `invalid input syntax for type uuid` from inside the
 * comparison. Nothing here catches that, and this function runs during `resolvePrincipal`, which
 * every server render awaits — so one malformed cookie 500s every page for that admin until the
 * cookie expires. That is the exact opposite of what the docstring below promises. Rejecting the
 * value before it reaches the database makes a garbage cookie indistinguishable from a cookie
 * naming an org that does not exist, which is what it is.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apply the admin active-org switch, or fall through to the user's own org.
 *
 * The `getOrganization` round trip is not decoration. Without it, `admin` plus an arbitrary uuid in
 * a cookie would set `app.current_org` to a tenant that does not exist. That is fail-closed at the
 * database (no rows match), but it presents as a mysteriously empty console rather than as "that is
 * not an organization", and it would let a stale cookie outlive the org it names. Verifying the id
 * means the switch either lands somewhere real or does not happen at all.
 */
async function resolveActiveOrg(roles: Role[], ownOrgId: string): Promise<string> {
  if (!rolesAllow(roles, "admin")) return ownOrgId;
  const requested = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  if (!requested || requested === ownOrgId) return ownOrgId;
  // Shape first, existence second. A cookie is client-controlled, so the value that reaches a
  // `uuid` column must be one this process has already checked.
  if (!UUID_RE.test(requested)) return ownOrgId;
  const org = await getOrganization(requested);
  return org ? org.id : ownOrgId;
}

/**
 * The tenant an admin is currently acting inside, when it is NOT their own — otherwise `null`
 * (PHASE6 §6.5). Rendered in the console header by `ActiveOrgBadge`.
 *
 * WHY THE UI OWES THIS. The switch is admin-gated, existence-checked and audited, and none of that
 * tells the admin where they are right now. Every page in the console renders another hospital's
 * cases and protocols with no indication that anything is different, so the failure mode is not an
 * attack — it is an admin who switched, got distracted, and approves clinical guidance into the
 * wrong facility while the console shows them exactly what it always shows them. A short cookie
 * lifetime bounds how long that can last; this makes it visible while it is happening.
 *
 * Returns `null` for everyone who is not currently switched, so the header renders nothing in the
 * ordinary case and the badge is never background noise the eye learns to skip.
 */
export async function getActiveOrgOverride(): Promise<{ slug: string; name: string } | null> {
  const session = authConfigured(getEnv()) ? await auth() : null;
  const ownOrgId = session?.user?.orgId;
  if (!session?.user?.id || !ownOrgId) return null;
  const activeOrgId = await resolveActiveOrg(session.user.roles ?? [], ownOrgId);
  if (activeOrgId === ownOrgId) return null;
  const org = await getOrganization(activeOrgId);
  return org ? { slug: org.slug, name: org.name } : null;
}
