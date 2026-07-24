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
const RANK: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i])) as Record<Role, number>;

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
] as const;
export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number];

/**
 * Minimum role per action. The plan's matrix, stated once:
 *  - pharmacist resolves exceptions and reviews cases (approve/edit/reject) and acknowledges;
 *  - pharmacy_director additionally approves/supersedes protocol versions;
 *  - admin additionally manages users;
 *  - viewer holds none of these (read-only) — and is what the public demo maps a visitor to.
 */
export const ACTION_MIN_ROLE: Record<ConsoleAction, Role> = {
  review_case: "pharmacist",
  resolve_exception: "pharmacist",
  approve_protocol_version: "pharmacy_director",
  manage_users: "admin",
};

/** Does `have` meet or exceed `min` in the role rank? */
export function roleSatisfies(have: Role, min: Role): boolean {
  return RANK[have] >= RANK[min];
}

/** Does any of the caller's roles meet the minimum? */
export function rolesAllow(roles: Role[], min: Role): boolean {
  return roles.some((r) => roleSatisfies(r, min));
}

/** Is this set of roles permitted to perform `action`? */
export function isActionAllowed(roles: Role[], action: ConsoleAction): boolean {
  return rolesAllow(roles, ACTION_MIN_ROLE[action]);
}

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
