import { describe, expect, it, vi } from "vitest";

/**
 * Per-request tenant scoping (PHASE6 §6.5). No live Postgres: `getDb` is mocked at the module
 * boundary and the assertions are about the SQL `withOrgDb` emits and the order it emits it in.
 *
 * That is deliberately the whole surface under test here. The isolation itself is enforced by
 * Postgres, and proving it needs a real database — those tests live in `rls.e2e.test.ts` and are
 * excluded from the default run. What CAN be proved without a database, and matters just as much,
 * is that the scope is set with `set_config(..., true)` (transaction-local, so it cannot leak to
 * the next checkout of a pooled connection), that it is set BEFORE the callback runs, and that a
 * malformed org never reaches the database at all.
 */

interface Executed {
  sql: string;
  params: unknown[];
}

const executed: Executed[] = [];

/** A transaction handle that records what was executed against it. */
function makeTx() {
  return {
    execute: (q: { queryChunks?: unknown[] }) => {
      // drizzle's `sql` template keeps its literal segments as `StringChunk`s (an object with an
      // array `value`) and leaves every interpolated value as a bare chunk, which the dialect
      // later turns into a bound `$n`. Splitting on that distinction reconstructs "what is SQL
      // TEXT" versus "what is a PARAMETER" — the exact question this file needs to answer.
      const chunks = (q.queryChunks ?? []) as unknown[];
      const isLiteral = (c: unknown): c is { value: string[] } =>
        typeof c === "object" && c !== null && Array.isArray((c as { value?: unknown }).value);
      const text = chunks.map((c) => (isLiteral(c) ? c.value.join("") : "$?")).join("");
      const params = chunks.filter((c) => !isLiteral(c));
      executed.push({ sql: text, params });
      return Promise.resolve([]);
    },
  };
}

const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()));

/** A marker object so "which pool did this land on?" is an assertable fact below. */
const MAINTENANCE_DB = { pool: "maintenance" };

vi.mock("./client.js", () => ({
  getDb: () => ({ transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn) }),
  getMaintenanceDb: () => MAINTENANCE_DB,
}));

const { withOrgDb, withBypassDb } = await import("./org-context.js");

const ORG = "00000000-0000-0000-0000-0000000000a1";

describe("withOrgDb", () => {
  it("sets app.current_org with set_config(..., true) — TRANSACTION-local, not session-local", async () => {
    executed.length = 0;
    await withOrgDb(ORG, async () => "done");
    expect(executed).toHaveLength(1);
    // `set_config(name, value, is_local)` rather than `SET LOCAL`: only the function form accepts
    // a bind parameter, so the org id crosses the wire as DATA and never as concatenated SQL.
    expect(executed[0]!.sql).toContain("set_config('app.current_org'");
    // The third argument is the one that matters: `true` scopes the setting to this transaction,
    // so a pooled connection cannot hand the next request the previous request's tenant.
    expect(executed[0]!.sql).toContain("true");
    expect(executed[0]!.sql).not.toMatch(/\bset\s+app\.current_org\b/i);
    expect(executed[0]!.params).toEqual([ORG]);
  });

  it("passes the org as a bound parameter, never interpolated into the SQL text", async () => {
    executed.length = 0;
    await withOrgDb(ORG, async () => undefined);
    expect(executed[0]!.sql).not.toContain(ORG);
    expect(executed[0]!.params).toContain(ORG);
  });

  it("sets the scope BEFORE the callback runs", async () => {
    executed.length = 0;
    let sawAtCallbackTime = -1;
    await withOrgDb(ORG, async () => {
      sawAtCallbackTime = executed.length;
    });
    // A callback that ran first would issue its queries on an unscoped connection — which, being
    // fail-closed, would return zero rows and look like "no data" rather than an error.
    expect(sawAtCallbackTime).toBe(1);
  });

  it("runs the callback inside a transaction and returns its value", async () => {
    transaction.mockClear();
    const result = await withOrgDb(ORG, async () => ({ rows: 3 }));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rows: 3 });
  });

  it("hands the callback the TRANSACTION handle, not the pool", async () => {
    let handle: unknown;
    await withOrgDb(ORG, async (db) => {
      handle = db;
    });
    // Queries issued on any other handle land on a different pooled connection where
    // `app.current_org` is unset.
    expect(handle).toHaveProperty("execute");
  });

  for (const bad of [
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-0000000000a",
    "'; drop table cases; --",
  ]) {
    it(`rejects a non-uuid org (${JSON.stringify(bad)}) before touching the database`, async () => {
      transaction.mockClear();
      executed.length = 0;
      await expect(withOrgDb(bad, async () => "unreachable")).rejects.toThrow(/must be a uuid/);
      // The point of validating at the boundary: a bad org must fail HERE, naming the caller,
      // rather than as a `::uuid` cast error raised from inside a policy mid-statement.
      expect(transaction).not.toHaveBeenCalled();
      expect(executed).toHaveLength(0);
    });
  }

  it("accepts an upper-case uuid (Postgres uuids are case-insensitive)", async () => {
    await expect(withOrgDb(ORG.toUpperCase(), async () => "ok")).resolves.toBe("ok");
  });
});

describe("withBypassDb", () => {
  it("sets NO org scope — an unscoped connection is fail-closed, not fail-open", async () => {
    executed.length = 0;
    const result = await withBypassDb(async () => "cross-tenant job");
    expect(executed).toHaveLength(0);
    expect(result).toBe("cross-tenant job");
    // With `app.current_org` unset, `current_setting('app.current_org', true)` is NULL, every
    // policy predicate is NULL, and NULL is not TRUE: the rows are invisible. Which is exactly why
    // the absence of a scope is NOT sufficient on its own — see the next test.
  });

  it("runs on the MAINTENANCE pool, not the application pool", async () => {
    // The regression this pins is the one that made `withBypassDb` a no-op: it used to call
    // `fn(getDb())`, i.e. hand the callback the same connection as every scoped query. RLS applies
    // to a ROLE, so on that connection nothing is bypassed — the deployment then had to choose
    // between enforcing isolation (and breaking sign-in, REST auth and anchoring) or running as a
    // superuser (and enforcing nothing). Landing on a separately-configured pool is what makes both
    // work, so "which pool" is the assertion, not an implementation detail.
    let handle: unknown;
    await withBypassDb(async (db) => {
      handle = db;
    });
    expect(handle).toBe(MAINTENANCE_DB);
  });
});
