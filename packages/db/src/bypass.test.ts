import { describe, expect, it, vi } from "vitest";

/**
 * THE TWO SANCTIONED CROSS-TENANT READS (PHASE6 §6.5), and the fact that there are only two.
 *
 * `getUserByOidc` (sign-in) and `findActiveApiKeyByPlaintext` (REST auth) run OUTSIDE `withOrgDb`
 * by necessity: both are asked "who is this?" by a caller who has presented one opaque credential
 * and nothing else, so the org is their OUTPUT and cannot be their filter. Everything else in the
 * application is org-scoped.
 *
 * "Unscoped" is not "may read everything", and that distinction is what these tests pin. The blast
 * radius of each lookup is bounded by its QUERY rather than by trust:
 *
 *  - the predicate is an exact match on a deployment-unique value (an IdP subject, or the SHA-256
 *    of a 256-bit secret) — an attacker cannot steer it toward a row they do not already hold the
 *    credential for;
 *  - the read is `LIMIT 1`, so even a hypothetical predicate bug cannot return a second tenant's
 *    row alongside the right one;
 *  - the API-key lookup additionally filters `revoked_at IS NULL` inside the SQL, so a revoked key
 *    can never be returned by a caller who forgets to check the field.
 *
 * No live database: the query builder is faked so the assertions are about the SHAPE of the query
 * each function issues, which is the thing that actually bounds it.
 */

interface Recorded {
  predicateNames: string[];
  limit: number | undefined;
}

const recorded: Recorded[] = [];

/** Collect the column names a drizzle predicate tree references. */
function predicateNames(node: unknown): string[] {
  const names: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    if (typeof rec.name === "string" && typeof rec.columnType === "string") {
      names.push(rec.name);
      return;
    }
    for (const value of Object.values(rec)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(node);
  // De-duplicated: one `eq(col, value)` can surface the same column reference more than once as
  // the tree is walked, and this assertion is about WHICH columns bound the query, not how many
  // times each appears.
  return [...new Set(names)];
}

function fakeDb(rows: Record<string, unknown>[]) {
  const chain = () => {
    const entry: Recorded = { predicateNames: [], limit: undefined };
    const self: Record<string, unknown> = {};
    self.from = () => self;
    self.where = (p: unknown) => {
      entry.predicateNames = predicateNames(p);
      return self;
    };
    self.limit = (n: number) => {
      entry.limit = n;
      recorded.push(entry);
      // The DATABASE applies the limit; model that here so a missing `.limit(1)` cannot be hidden
      // by a fixture that happens to contain one row.
      return Promise.resolve(rows.slice(0, n));
    };
    return self;
  };
  return { select: () => chain() };
}

const rows: Record<string, unknown>[] = [];
// Both pools resolve to the same fake here. These two reads go through `withBypassDb`, which uses
// the MAINTENANCE pool (PHASE6 §6.5) — which connection they land on is a deployment concern; what
// this file pins is the shape of the query, and that is identical either way.
vi.mock("./client.js", () => ({ getDb: () => fakeDb(rows), getMaintenanceDb: () => fakeDb(rows) }));

const { getUserByOidc } = await import("./users.js");
const { findActiveApiKeyByPlaintext, hashApiKey } = await import("./api-keys.js");

function reset(fixture: Record<string, unknown>[]) {
  recorded.length = 0;
  rows.length = 0;
  rows.push(...fixture);
}

describe("getUserByOidc — the sign-in bootstrap read", () => {
  it("returns at most ONE row, matched on the IdP subject alone", async () => {
    reset([
      { id: "u-a", orgId: "org-a", oidcSubject: "sub-1" },
      // A second row that must never come back with the first. It cannot exist in reality —
      // `users_oidc_subject_uq` is deployment-wide — but the query must not depend on that.
      { id: "u-b", orgId: "org-b", oidcSubject: "sub-1" },
    ]);
    const row = await getUserByOidc("sub-1");
    expect(row).toEqual({ id: "u-a", orgId: "org-a", oidcSubject: "sub-1" });
    expect(recorded[0]?.limit).toBe(1);
    expect(recorded[0]?.predicateNames).toEqual(["oidc_subject"]);
  });

  it("returns undefined for a subject that has never signed in — no fallback row", async () => {
    reset([]);
    await expect(getUserByOidc("nobody")).resolves.toBeUndefined();
  });
});

describe("findActiveApiKeyByPlaintext — the REST auth bootstrap read", () => {
  it("returns at most ONE row, matched on the secret's HASH and revocation state", async () => {
    reset([
      { id: "k-a", orgId: "org-a" },
      { id: "k-b", orgId: "org-b" },
    ]);
    const row = await findActiveApiKeyByPlaintext("sk_live_secret");
    expect(row).toEqual({ id: "k-a", orgId: "org-a" });
    expect(recorded[0]?.limit).toBe(1);
    // `key_hash` bounds it to the presented credential; `revoked_at` is IN THE QUERY so a caller
    // that forgets to test the field still cannot authenticate a revoked key.
    expect(recorded[0]?.predicateNames).toEqual(["key_hash", "revoked_at"]);
    // And nothing org-shaped appears — the org is the ANSWER here, not the filter.
    expect(recorded[0]?.predicateNames).not.toContain("org_id");
  });

  it("never compares the secret itself, only its digest", () => {
    // The lookup matches on a hash column, so there is no byte-by-byte comparison of the secret
    // whose early exit could leak it through timing; the index probe depends on a value an
    // attacker cannot steer without already knowing the key.
    expect(hashApiKey("sk_live_secret")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("sk_live_secret")).not.toContain("sk_live_secret");
  });

  it("returns undefined for an unknown secret — no partial match, no fallback tenant", async () => {
    reset([]);
    await expect(findActiveApiKeyByPlaintext("sk_live_nope")).resolves.toBeUndefined();
  });
});
