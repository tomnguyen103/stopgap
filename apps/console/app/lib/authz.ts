import { ROLES, type Role } from "@stopgap/core";

/**
 * The authorization matrix (PHASE6 §6.1) as PURE data + functions — no session, no NextAuth,
 * no DB. Everything side-effectful (reading the session, throwing in a server action) is a thin
 * wrapper over this file, so the entire allow/deny policy is unit-testable without a live IdP.
 *
 * Roles form a RANK (see `@stopgap/core`'s ordered `ROLES`): a higher role satisfies any lower
 * requirement, so a `pharmacy_director` implicitly passes a `pharmacist` gate. Each mutating
 * console action maps to the MINIMUM role that may perform it; a caller is allowed iff any role
 * they hold meets that minimum.
 */

/** viewer < pharmacist < pharmacy_director < admin — the index in `ROLES` is the rank. */
const RANK: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i])) as Record<
  Role,
  number
>;

/**
 * Mutating actions the console/API gates — one entry per action a server action actually
 * enforces. Read pages need only an authenticated `viewer`. (The plan's matrix also names
 * spend-cap and demo-config admin capabilities; those gate no server action in 6.1, so they are
 * intentionally absent here — a later PR that wires those mutations re-adds its own entry rather
 * than leaving dead policy that nothing checks.)
 */
export const CONSOLE_ACTIONS = [
  "review_case",
  "resolve_exception",
  "approve_protocol_version",
  "manage_users",
  "manage_api_keys",
] as const;
export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number];

/**
 * Minimum role per action. The plan's matrix, stated once:
 *  - pharmacist resolves exceptions and reviews cases (approve/edit/reject) and acknowledges;
 *  - pharmacy_director additionally approves/supersedes protocol versions;
 *  - admin additionally manages users and issues/revokes API keys;
 *  - viewer holds none of these (read-only) — and is what the public demo maps a visitor to.
 *
 * `manage_api_keys` is `admin` (PHASE6 §6.7) and could not be lower: a key is a standing
 * credential that carries scopes, so anyone who can issue one can hand out any capability the
 * scope set covers — including `protocols:write`. Letting a pharmacy_director mint keys would let
 * them delegate write access they hold to an integration nobody else approved, which is privilege
 * escalation by a slower route.
 */
export const ACTION_MIN_ROLE: Record<ConsoleAction, Role> = {
  review_case: "pharmacist",
  resolve_exception: "pharmacist",
  approve_protocol_version: "pharmacy_director",
  manage_users: "admin",
  manage_api_keys: "admin",
};

/** Does `have` meet or exceed `min` in the role rank? */
export function roleSatisfies(have: Role, min: Role): boolean {
  return RANK[have] >= RANK[min];
}

/** Does any of the caller's roles meet the minimum? */
export function rolesAllow(roles: readonly Role[], min: Role): boolean {
  return roles.some((r) => roleSatisfies(r, min));
}

/** Is this set of roles permitted to perform `action`? */
export function isActionAllowed(roles: Role[], action: ConsoleAction): boolean {
  return rolesAllow(roles, ACTION_MIN_ROLE[action]);
}

/**
 * Where each role lands after sign-in (unified-platform-spec, Phase F).
 *
 * Every role gets its own dashboard, so the post-sign-in redirect needs a role → route map. It
 * lives here, beside the rank, because resolving it is pure rank arithmetic and belongs in the
 * same unit-tested file as the rest of the matrix — the middleware that consumes it stays a
 * one-line wrapper, and per-role routing never needs a browser to be proven.
 *
 * This is ROUTING, not authorization. Landing on a route is not permission to act there: every
 * page read and every server action still calls its own guard, exactly as before. The two concerns
 * are deliberately not merged — a future dashboard that a role can *see* but only partly *use* is
 * normal, and would be unrepresentable if the landing map doubled as policy.
 *
 * Routes are root-relative by construction. The value is fed to a redirect, so a protocol-relative
 * or absolute value here would be an open redirect; the suite asserts the shape rather than
 * trusting review to catch a future edit.
 */
export const ROLE_LANDING_ROUTE: Record<Role, string> = {
  viewer: "/overview",
  pharmacist: "/queue",
  pharmacy_director: "/oversight",
  admin: "/admin",
};

/**
 * The dashboard a caller lands on: the route of their HIGHEST role, mirroring `rolesAllow`'s
 * "any role may satisfy" rule so routing and permission can never disagree about which role a
 * multi-role user effectively holds.
 *
 * Total by construction — it always returns a route:
 *  - no roles at all (the anonymous visitor `STOPGAP_DEMO_MODE` resolves) lands on the viewer
 *    dashboard, which is what makes the public demo and the lowest-privilege surface one thing to
 *    build rather than two;
 *  - a role this build does not know is skipped rather than thrown on. Roles are unioned from IdP
 *    realm claims and local grants, so an IdP can legitimately present a realm role a given deploy
 *    has never heard of; a throw here would turn that into a failed sign-in redirect instead of a
 *    harmless degrade to `viewer`.
 */
export function roleLandingRoute(roles: readonly Role[]): string {
  let best: Role = "viewer";
  for (const role of roles) {
    const rank = RANK[role];
    if (rank === undefined) continue;
    if (rank > RANK[best]) best = role;
  }
  return ROLE_LANDING_ROUTE[best];
}

/**
 * The four dashboard groups (ticket 03), each one role's surface.
 *
 * Named the same as the role whose landing route it holds, because a group that did not map 1:1
 * onto a role would need its own access rule, and a second rule is a second thing to get wrong.
 */
export const DASHBOARD_GROUPS = ["viewer", "pharmacist", "pharmacy_director", "admin"] as const;
export type DashboardGroup = (typeof DASHBOARD_GROUPS)[number];

/**
 * May this caller see this group's surface?
 *
 * At or BELOW their own rank. A director looking at the viewer overview is reading a subset of
 * what their own dashboard shows, so refusing it would be theatre; a viewer reaching the admin
 * surface is not, and is refused.
 *
 * This is VISIBILITY, not permission. Reaching a route grants nothing: every page read and every
 * server action still calls its own guard, exactly as before. The two are deliberately separate —
 * a dashboard a role can see but only partly use is normal, and would be unrepresentable if this
 * function doubled as policy.
 *
 * IT ADMITS AT OR BELOW RANK, so "another role's route is refused server-side" holds UPWARD only:
 * a viewer cannot reach the director's oversight, while a director can read the pharmacist queue.
 * That direction is the intended one — a director asked to explain a decision needs to see the
 * queue it came from — but it has a consequence worth naming, because it is not a bug someone
 * should later "fix": the per-group navs list only their OWN group's routes, so a higher role can
 * reach a lower group's page but has no link to it. The alternative, composing every visible
 * group's links into one nav, rebuilds the undifferentiated header the route groups exist to
 * replace. Typing the URL is the deliberate cost.
 */
export function canViewGroup(roles: readonly Role[], group: DashboardGroup): boolean {
  let best: number | undefined;
  for (const role of roles) {
    const rank = RANK[role];
    // An unknown role is skipped rather than thrown on, for the reason `roleLandingRoute` gives:
    // an IdP may legitimately present a realm role this build has never heard of.
    if (rank !== undefined && (best === undefined || rank > best)) best = rank;
  }
  // NO RECOGNIZED ROLE IS NOT THE LOWEST ROLE. Starting this at `viewer` admitted an empty role set
  // — and an empty set is exactly what a realm whose Stopgap client mapper is missing produces, so
  // the default was handing tenant viewer data to anyone the IdP would authenticate. The anonymous
  // demo path is unaffected: `resolvePrincipal` gives that caller the real `viewer` role, not none.
  if (best === undefined) return false;
  return best >= RANK[group];
}

/**
 * Does this caller hold any role this build recognizes?
 *
 * The question `canViewGroup` cannot answer on its own: it returns false both for "your role is too
 * low for THIS group" and for "you have no role at all", and those need different destinations. The
 * first redirects to the caller's own dashboard; the second has no dashboard to go to, and sending
 * it to one loops — the guard there refuses it again.
 */
export function hasRecognizedRole(roles: readonly Role[]): boolean {
  return roles.some((role) => RANK[role] !== undefined);
}

/** Where a caller with no recognized role goes. Outside every dashboard group, so it cannot loop. */
export const ACCESS_DENIED_ROUTE = "/access-denied";

/** Thrown when a caller lacks the role an action requires. The server action surfaces it. */
export class AuthorizationError extends Error {
  constructor(
    readonly action: ConsoleAction,
    readonly roles: Role[],
  ) {
    super(
      `Not authorized to ${action}: requires ${ACTION_MIN_ROLE[action]}, ` +
        `caller has [${roles.join(", ") || "none"}].`,
    );
    this.name = "AuthorizationError";
  }
}

/** Pure guard: throw `AuthorizationError` unless `roles` may perform `action`. */
export function assertRoleFor(roles: Role[], action: ConsoleAction): void {
  if (!isActionAllowed(roles, action)) throw new AuthorizationError(action, roles);
}
