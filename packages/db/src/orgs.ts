import { asc, eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { organizations, type OrganizationRow } from "./schema.js";

/**
 * Organization store (PHASE6 §6.5) — the tenant registry behind Postgres row-level security.
 *
 * Deliberately tiny, in the same spirit as `users.ts`: an org is an isolation boundary, so the
 * only operations that belong here are the ones a boundary needs (list them, resolve one, create
 * one). Anything per-org that is CONFIGURATION belongs on the table it configures, not here.
 *
 * These functions run OUTSIDE `withOrgDb` on purpose. `organizations` carries no RLS policy — a
 * session has to be able to resolve its own org before `app.current_org` can be set, and an
 * isolation policy on the table that defines isolation is a chicken-and-egg with no exit.
 */

/**
 * The fixed id of the organization every pre-multi-tenancy row was backfilled into.
 *
 * Deterministic (not `defaultRandom`) for exactly the reasons `SYNTHETIC_USER_IDS` is: migration
 * 0013's backfill has to name the org in raw SQL, and application code — the demo seeder, the
 * compose stack, the pass-2 console default — has to name the SAME org without a lookup
 * round-trip and without depending on whatever uuid a particular database happened to generate.
 * A fixed literal makes "the seed org" mean one thing in every deployment, which is what lets a
 * dump from one machine be read on another.
 *
 * Chosen in the same `0000…` sentinel namespace as the synthetic users, with a distinct tail, so
 * a human reading a raw row can tell at a glance that it is a seeded fixture and not real data.
 */
export const SEED_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

/** Slug of the seed organization — the handle migration 0013 inserts and the demo maps to. */
export const SEED_ORG_SLUG = "stopgap";

/**
 * The SECOND organization (PHASE6 §6.5 acceptance: "two seeded orgs run side by side; cases,
 * protocols, shadow, audit fully disjoint").
 *
 * One tenant proves nothing about isolation — every query returns the same rows whether or not the
 * policies work. A second tenant with its own cases, protocols and audit chain is what makes the
 * claim falsifiable: switch the active org in the console and the case list must change completely,
 * and the audit chain must verify from ITS own genesis rather than continuing the seed org's.
 *
 * Inserted by migration 0014 rather than only by the demo seeder, because the seeder refuses to run
 * outside `STOPGAP_DEMO_MODE=on` (its cases are fiction and must not appear beside real shortages).
 * The org ROW is not fiction — it is an empty isolation boundary — so a plain `pnpm db:migrate`
 * yields two tenants, and the demo seeder then fills both with content when demo mode is on.
 *
 * Same fixed-uuid reasoning as `SEED_ORG_ID`, with the next sentinel tail so the two read as a pair.
 */
export const SECOND_ORG_ID = "00000000-0000-0000-0000-0000000000a2";

/** Slug of the second seeded organization. */
export const SECOND_ORG_SLUG = "riverside";

/** Display name of the second seeded organization. */
export const SECOND_ORG_NAME = "Riverside General (second seeded organization)";

/** Every organization, oldest first — the admin org list and the cross-tenant ops views. */
export async function listOrganizations(): Promise<OrganizationRow[]> {
  const db = getDb();
  return db.select().from(organizations).orderBy(asc(organizations.createdAt));
}

/** One organization by id, or undefined. The lookup a session does to name its own tenant. */
export async function getOrganization(id: string): Promise<OrganizationRow | undefined> {
  const db = getDb();
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row;
}

/**
 * Create an organization. `slug` is unique, so a repeated create is a constraint error rather
 * than a second tenant wearing the same handle — a duplicate slug would make every URL and ops
 * command that addresses an org by name ambiguous, which is worse than a failed insert.
 */
export async function createOrganization(input: { slug: string; name: string }): Promise<OrganizationRow> {
  const db = getDb();
  const [row] = await db.insert(organizations).values({ slug: input.slug, name: input.name }).returning();
  if (!row) throw new Error(`createOrganization: insert returned no row for ${input.slug}`);
  return row;
}
