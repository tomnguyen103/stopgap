import { isRole, type Role } from "@stopgap/core";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, type Db } from "./client.js";
import { withBypassDb } from "./org-context.js";
import { userRoles, users, type UserRow } from "./schema.js";

/**
 * User/role store (PHASE6 §6.1). Small, deliberate surface: sign-in upserts a user by OIDC
 * subject and reads its roles; admin management assigns/revokes roles and disables accounts;
 * the audit chain resolves the two synthetic principals below. No password state lives here —
 * authentication is the IdP's job; this table only records WHO an authenticated subject is and
 * WHAT they may do.
 */

/**
 * Fixed ids for the pre-auth actors of the audit chain. Deterministic (not `defaultRandom`) so
 * the migration backfill and `getSyntheticUser` agree without a lookup round-trip, and so the
 * same ids mean the same principal across every deployment. `system` = the workflow engine
 * itself (detections, status transitions, comms); `agent` = the LLM research/assessment layer.
 */
export const SYNTHETIC_USER_IDS = {
  system: "00000000-0000-0000-0000-000000000001",
  agent: "00000000-0000-0000-0000-000000000002",
} as const;

export type SyntheticUser = keyof typeof SYNTHETIC_USER_IDS;

/** The fixed `users.id` for a synthetic principal — the value the audit chain's FK points at. */
export function getSyntheticUser(which: SyntheticUser): string {
  return SYNTHETIC_USER_IDS[which];
}

/**
 * The synthetic `users.id` behind a text actor label, if the label names one (`system`/`agent`),
 * else undefined. Derived from `SYNTHETIC_USER_IDS` so callers never re-hardcode the literals —
 * a human label ("pharmacist-console") has no synthetic id and returns undefined.
 */
export function syntheticUserIdForLabel(label: string): string | undefined {
  return label in SYNTHETIC_USER_IDS ? SYNTHETIC_USER_IDS[label as SyntheticUser] : undefined;
}

export interface UpsertUserInput {
  /**
   * The tenant this human belongs to (PHASE6 §6.5). Applied on INSERT only — an existing user's
   * org is never rewritten by a sign-in. Moving a person between hospitals would silently detach
   * every audit entry, acknowledgment and approval they own from the org that can still read
   * them; that is an admin operation with its own confirmation, not a side effect of logging in.
   */
  orgId: string;
  oidcSubject: string;
  email?: string | null;
  displayName?: string | null;
}

/**
 * Find-or-create the local user for an OIDC subject, refreshing email/display name from the
 * token on every sign-in (they change in the IdP, and the local copy should not go stale).
 * Keyed on `oidcSubject` (the IdP `sub`), which is unique where present, so concurrent sign-ins
 * of the same subject converge on one row instead of racing to insert duplicates.
 */
export async function upsertUserByOidc(input: UpsertUserInput): Promise<UserRow> {
  // Same bootstrap as `getUserByOidc`, and unscoped for the same reason: at sign-in the caller has
  // an IdP subject and no org yet, and for a RETURNING user the org is the row's own value — the
  // answer, not the filter. `input.orgId` applies on INSERT only (see `UpsertUserInput`), so this
  // never rewrites an existing person's tenant.
  return withBypassDb(async (db) => upsertUserByOidcOn(db, input));
}

async function upsertUserByOidcOn(db: Db, input: UpsertUserInput): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      orgId: input.orgId,
      oidcSubject: input.oidcSubject,
      email: input.email ?? null,
      displayName: input.displayName ?? null,
    })
    .onConflictDoUpdate({
      target: users.oidcSubject,
      // `users_oidc_subject_uq` is a PARTIAL unique index (WHERE oidc_subject IS NOT NULL,
      // migration 0010). Postgres only accepts a partial index as the ON CONFLICT arbiter when
      // the conflict target repeats its predicate; without `targetWhere` it raises 42P10
      // ("no unique or exclusion constraint matching") and every sign-in throws. This mirrors
      // the index's WHERE clause so the upsert resolves against it.
      targetWhere: isNotNull(users.oidcSubject),
      set: { email: input.email ?? null, displayName: input.displayName ?? null },
    })
    .returning();
  if (row) return row;
  // A partial unique index can leave `onConflictDoUpdate` without a matched row in edge cases;
  // fall back to a direct read so a successful sign-in never returns undefined.
  const [existing] = await db.select().from(users).where(eq(users.oidcSubject, input.oidcSubject)).limit(1);
  if (!existing) throw new Error(`upsertUserByOidc: user vanished for subject ${input.oidcSubject}`);
  return existing;
}

/**
 * The local user for an OIDC subject, if one exists — the sign-in gate reads this BEFORE the
 * upsert so a disabled account (`disabledAt` set) can be denied instead of getting a fresh token
 * with full roles (CWE-285). Returns undefined for a subject that has never signed in.
 *
 * Takes NO `orgId`, unlike every other read in this file, and that is the whole point of keeping
 * `users_oidc_subject_uq` deployment-wide (see `schema.ts`): the OIDC callback carries a `sub`
 * and nothing else, so the org is the ANSWER this lookup produces — the value the caller then
 * passes to `withOrgDb` for the rest of the request. It therefore runs unscoped by necessity,
 * which is safe precisely because one subject can only ever resolve to one row.
 *
 * It therefore runs through `withBypassDb` — one of exactly TWO sanctioned cross-tenant reads in
 * the application (the other is `findActiveApiKeyByPlaintext`), named so a reviewer can grep for
 * them rather than having to notice a missing `withOrgDb`. The blast radius is bounded by the
 * query, not by trust: `oidc_subject` is unique deployment-wide and the read is `.limit(1)`, so the
 * most this can ever return is the ONE row belonging to the subject that just authenticated —
 * "unscoped" here means "not yet scoped", never "may read everything".
 */
export async function getUserByOidc(oidcSubject: string): Promise<UserRow | undefined> {
  return withBypassDb(async (db) => {
    const [row] = await db.select().from(users).where(eq(users.oidcSubject, oidcSubject)).limit(1);
    return row;
  });
}

/**
 * ROLE GRANTS ARE ORG-SCOPED THROUGH `users` (PHASE6 §6.5).
 *
 * `user_roles` carries no `org_id` and no RLS policy: a grant is scoped TRANSITIVELY through the
 * user it names (a second copy of the org here could disagree with the first — see `schema.ts`).
 * "Transitively" is only true if something actually walks the relationship, though, and until this
 * change nothing did. The three helpers below took a bare `users.id`, ran on the unscoped pool, and
 * so an admin acting in org A could grant or revoke any role on any user in org B just by knowing
 * the uuid — without the audited org switch, and with the audit entry filed in the ACTING admin's
 * org, so the target hospital's own chain never recorded that its user's privileges changed.
 *
 * The fix is the pattern `listRoleRecipients` in `escalation.ts` already used: put the org
 * predicate on `users`, which is the RLS-protected table, and make every caller pass an org-scoped
 * handle from `withOrgDb`. The membership check below is the belt to that braces — under RLS a
 * foreign user is invisible and the check fails; on a connection where the policies do not apply
 * (a superuser dev stack) the explicit predicate is what still refuses.
 *
 * A refusal THROWS rather than returning `false`. `false` already means "no change was needed"
 * (the user already held the role), and collapsing "nothing to do" together with "you tried to
 * modify another hospital's user" would make a cross-tenant attempt indistinguishable from a
 * no-op — silently swallowed, unlogged, and reported to the admin as success.
 */
export async function isUserInOrg(db: Db, orgId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);
  return row !== undefined;
}

async function assertUserInOrg(db: Db, orgId: string, userId: string): Promise<void> {
  if (!(await isUserInOrg(db, orgId, userId))) {
    throw new Error(`user ${userId} is not a member of organization ${orgId}`);
  }
}

/** The roles a user currently holds, validated against the known set (a stray value is dropped). */
export async function getUserRoles(db: Db, orgId: string, userId: string): Promise<Role[]> {
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(users.orgId, orgId), eq(userRoles.userId, userId)));
  return rows.map((r) => r.role).filter(isRole);
}

/**
 * The roles of MANY users in one query, keyed by user id (PHASE6 §6.5).
 *
 * Exists because the per-user form inside `listUsers` was both an N+1 and a pool deadlock: the list
 * runs inside `withOrgDb`, which holds one of the pool's ten connections for its transaction, and
 * each per-user role read checked out a SECOND connection from the same pool. Ten concurrent admin
 * page loads take all ten connections, then every one of them waits forever for an eleventh —
 * `postgres.js` has no checkout timeout, so the console hangs rather than erroring. One query on
 * the handle already held has neither problem.
 *
 * A user with no grants is absent from the map, not present with an empty array; callers default.
 */
export async function getRolesForUsers(
  db: Db,
  orgId: string,
  userIds: string[],
): Promise<Map<string, Role[]>> {
  const byUser = new Map<string, Role[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .select({ userId: userRoles.userId, role: userRoles.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(users.orgId, orgId), inArray(userRoles.userId, userIds)));
  for (const row of rows) {
    if (!isRole(row.role)) continue;
    const existing = byUser.get(row.userId);
    if (existing) existing.push(row.role);
    else byUser.set(row.userId, [row.role]);
  }
  return byUser;
}

/**
 * Grant a role. Idempotent: the `(userId, role)` unique index makes a re-grant a no-op. Returns
 * whether a row was actually inserted (`false` = the user already held the role) so the caller
 * can skip an audit entry that would otherwise claim a grant that never happened (PHASE6 §6.1).
 *
 * Throws if `userId` does not belong to `orgId` — see the note above `assertUserInOrg`.
 */
export async function assignRole(db: Db, orgId: string, userId: string, role: Role): Promise<boolean> {
  await assertUserInOrg(db, orgId, userId);
  const inserted = await db
    .insert(userRoles)
    .values({ userId, role })
    .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] })
    .returning({ id: userRoles.id });
  return inserted.length > 0;
}

/**
 * Revoke a role. Returns whether a row was actually deleted (`false` = the user never held it).
 * Throws if `userId` does not belong to `orgId`.
 */
export async function revokeRole(db: Db, orgId: string, userId: string, role: Role): Promise<boolean> {
  await assertUserInOrg(db, orgId, userId);
  const deleted = await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)))
    .returning({ id: userRoles.id });
  return deleted.length > 0;
}

/** Active (non-disabled) users in one org, with their roles, for the admin management page. */
export async function listUsers(orgId: string, db: Db = getDb()): Promise<(UserRow & { roles: Role[] })[]> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.orgId, orgId), isNull(users.disabledAt)))
    .orderBy(asc(users.createdAt));
  // ONE role query on the handle we were given, not one per user on a fresh connection — see
  // `getRolesForUsers` for the deadlock that shape produced.
  const roles = await getRolesForUsers(db, orgId, rows.map((u) => u.id));
  return rows.map((u) => ({ ...u, roles: roles.get(u.id) ?? [] }));
}

/**
 * Soft-disable / re-enable an account without touching its audit provenance. The WHERE clause
 * only matches when the state actually flips (disable an enabled row, or enable a disabled one),
 * so `returning()` is empty on a no-op and the boolean tells the caller whether anything changed
 * — no audit entry for a toggle that did nothing (PHASE6 §6.1).
 */
export async function setUserDisabled(
  orgId: string,
  userId: string,
  disabled: boolean,
  db: Db = getDb(),
): Promise<boolean> {
  const changed = await db
    .update(users)
    .set({ disabledAt: disabled ? new Date() : null })
    .where(
      and(
        eq(users.orgId, orgId),
        eq(users.id, userId),
        disabled ? isNull(users.disabledAt) : isNotNull(users.disabledAt),
      ),
    )
    .returning({ id: users.id });
  return changed.length > 0;
}
