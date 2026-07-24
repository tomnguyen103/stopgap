import { isRole, type Role } from "@stopgap/core";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "./client.js";
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
  const db = getDb();
  const [row] = await db
    .insert(users)
    .values({
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
 */
export async function getUserByOidc(oidcSubject: string): Promise<UserRow | undefined> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.oidcSubject, oidcSubject)).limit(1);
  return row;
}

/** The roles a user currently holds, validated against the known set (a stray value is dropped). */
export async function getUserRoles(userId: string): Promise<Role[]> {
  const db = getDb();
  const rows = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
  return rows.map((r) => r.role).filter(isRole);
}

/**
 * Grant a role. Idempotent: the `(userId, role)` unique index makes a re-grant a no-op. Returns
 * whether a row was actually inserted (`false` = the user already held the role) so the caller
 * can skip an audit entry that would otherwise claim a grant that never happened (PHASE6 §6.1).
 */
export async function assignRole(userId: string, role: Role): Promise<boolean> {
  const db = getDb();
  const inserted = await db
    .insert(userRoles)
    .values({ userId, role })
    .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] })
    .returning({ id: userRoles.id });
  return inserted.length > 0;
}

/** Revoke a role. Returns whether a row was actually deleted (`false` = the user never held it). */
export async function revokeRole(userId: string, role: Role): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)))
    .returning({ id: userRoles.id });
  return deleted.length > 0;
}

/** Active (non-disabled) users with their roles, for the admin management page. */
export async function listUsers(): Promise<(UserRow & { roles: Role[] })[]> {
  const db = getDb();
  const rows = await db.select().from(users).where(isNull(users.disabledAt)).orderBy(asc(users.createdAt));
  return Promise.all(rows.map(async (u) => ({ ...u, roles: await getUserRoles(u.id) })));
}

/**
 * Soft-disable / re-enable an account without touching its audit provenance. The WHERE clause
 * only matches when the state actually flips (disable an enabled row, or enable a disabled one),
 * so `returning()` is empty on a no-op and the boolean tells the caller whether anything changed
 * — no audit entry for a toggle that did nothing (PHASE6 §6.1).
 */
export async function setUserDisabled(userId: string, disabled: boolean): Promise<boolean> {
  const db = getDb();
  const changed = await db
    .update(users)
    .set({ disabledAt: disabled ? new Date() : null })
    .where(and(eq(users.id, userId), disabled ? isNull(users.disabledAt) : isNotNull(users.disabledAt)))
    .returning({ id: users.id });
  return changed.length > 0;
}
