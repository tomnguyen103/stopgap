import { describe, expect, it, vi } from "vitest";

/**
 * Workflow-id format and case lookup across the PHASE6 §6.5 pass-2 transition.
 *
 * The whole point of this file is one migration hazard. `workflowIdForKey` used to return
 * `case-<key>` and now returns `org-<orgId>-case-<key>`, but Temporal cannot rename a running
 * execution and `cases.workflow_id` still holds the OLD value for every case opened before the
 * change. If any lookup recomputed an id instead of reading the row's, every pre-migration case
 * would become unreachable: the console would 404 it, the poll's resolution signal would land
 * nowhere, and `upsertCaseForRecord` would open a duplicate case for a drug already tracked.
 *
 * No live database: the query layer is exercised against a hand-rolled fake that implements just
 * enough of the drizzle builder chain to record what was asked for and answer from a fixture. The
 * assertions are about WHICH COLUMN each function filters on, which is exactly the property that
 * decides whether a legacy row is found.
 */

const ORG = "aaaaaaaa-0000-0000-0000-0000000000a1";

/** A case row as it exists in a database migrated from before pass 2 — OLD workflow id. */
const LEGACY_ROW = {
  id: "case-uuid-1",
  orgId: ORG,
  workflowId: "case-heparin-sodium",
  key: "heparin sodium",
  genericName: "Heparin Sodium Injection",
  source: "openfda",
  sourceId: "0338-0431-03:Current",
  status: "monitoring",
};

/**
 * Records the WHERE predicate drizzle built, by rendering the column references the `and`/`eq`
 * helpers produce. Good enough to answer "did this query filter on `key` or on `workflow_id`",
 * which is the only question these tests ask.
 */
const predicates: string[][] = [];

function renderPredicate(node: unknown): string[] {
  // drizzle's `eq`/`and` produce SQL objects whose `queryChunks` carry column refs; a column ref
  // exposes `name`. Walk the tree and collect the names, ignoring everything else.
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
  return names;
}

/**
 * An order-by argument rendered as text: the column name plus the ` asc` / ` desc` fragment
 * drizzle appends. Direction is the whole point for `listCasesAwaitingHuman`, whose cap keeps
 * whichever end of the list the ordering puts first.
 */
function renderOrder(node: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    if (typeof rec.name === "string" && typeof rec.columnType === "string") {
      parts.push(rec.name);
      return;
    }
    // A StringChunk — the literal SQL between the column refs.
    if (Array.isArray(rec.value) && rec.value.every((v) => typeof v === "string")) {
      parts.push(...(rec.value as string[]));
      return;
    }
    for (const value of Object.values(rec)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

const orderings: string[] = [];
const limits: number[] = [];

/** The subset of the drizzle select/insert/update chain these functions actually use. */
function fakeDb(rows: Record<string, unknown>[]) {
  const inserted: Record<string, unknown>[] = [];
  const chain = (result: unknown[]) => {
    const self: Record<string, unknown> = {};
    const passthrough = ["from", "set", "returning", "onConflictDoNothing"];
    for (const method of passthrough) self[method] = () => self;
    self.orderBy = (order: unknown) => {
      orderings.push(renderOrder(order));
      return self;
    };
    self.limit = (n: number) => {
      limits.push(n);
      return self;
    };
    self.where = (predicate: unknown) => {
      predicates.push(renderPredicate(predicate));
      return self;
    };
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return self;
  };
  return {
    inserted,
    db: {
      select: () => chain(rows),
      update: () => chain([]),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return chain([{ ...LEGACY_ROW, ...v }]);
        },
      }),
    },
  };
}

vi.mock("./client.js", () => ({ getDb: () => ({}) }));

const {
  workflowIdForKey,
  getCaseByKey,
  getCaseByWorkflowId,
  upsertCaseForRecord,
  listCasesAwaitingHuman,
} = await import("./cases.js");

describe("workflowIdForKey", () => {
  it("mints an ORG-QUALIFIED id for a new case", () => {
    expect(workflowIdForKey(ORG, "heparin sodium")).toBe(`org-${ORG}-case-heparin-sodium`);
  });

  it("gives two orgs DIFFERENT ids for the same drug", () => {
    const other = "bbbbbbbb-0000-0000-0000-0000000000b1";
    expect(workflowIdForKey(ORG, "heparin")).not.toBe(workflowIdForKey(other, "heparin"));
    // Temporal ids are unique per NAMESPACE, not per tenant: identical ids would make the second
    // hospital's detection collide with the first hospital's running workflow, and `startCase`
    // would report "already open" for a case that org has never had.
  });

  it("no longer produces the legacy format, which is exactly why lookups must not recompute", () => {
    expect(workflowIdForKey(ORG, "heparin sodium")).not.toBe("case-heparin-sodium");
  });
});

describe("finding a case written BEFORE the workflow-id format changed", () => {
  it("getCaseByKey filters on (org_id, key) — so a legacy row is still found", async () => {
    predicates.length = 0;
    const { db } = fakeDb([LEGACY_ROW]);
    const row = await getCaseByKey(db as never, ORG, "heparin sodium");
    expect(row).toEqual(LEGACY_ROW);
    // The predicate names `key`, never `workflow_id`: a lookup that recomputed the id would have
    // searched for `org-…-case-heparin-sodium` and found nothing, because the row holds
    // `case-heparin-sodium`.
    expect(predicates[0]).toContain("org_id");
    expect(predicates[0]).toContain("key");
    expect(predicates[0]).not.toContain("workflow_id");
  });

  it("getCaseByWorkflowId still works when handed the row's OWN stored id", async () => {
    predicates.length = 0;
    const { db } = fakeDb([LEGACY_ROW]);
    const row = await getCaseByWorkflowId(db as never, ORG, LEGACY_ROW.workflowId);
    expect(row).toEqual(LEGACY_ROW);
    expect(predicates[0]).toContain("workflow_id");
  });

  it("upsertCaseForRecord returns the LEGACY row instead of opening a duplicate case", async () => {
    predicates.length = 0;
    const { db, inserted } = fakeDb([LEGACY_ROW]);
    const row = await upsertCaseForRecord(db as never, ORG, {
      source: "openfda",
      sourceId: "0338-0431-03:Current",
      key: "heparin sodium",
      genericName: "Heparin Sodium Injection",
      status: "current",
      ndcs: [],
      rxcuis: [],
    });
    expect(row.workflowId).toBe("case-heparin-sodium");
    // NOTHING was inserted. Arbitrating on the newly computed id alone would have found no
    // conflict (the stored id differs) and written a second case row for a drug this org already
    // has a case for — a silent duplicate that `cases_key_idx`, being non-unique, would not stop.
    expect(inserted).toHaveLength(0);
  });

  it("mints the new format only when no case exists for the key", async () => {
    predicates.length = 0;
    const { db, inserted } = fakeDb([]);
    await upsertCaseForRecord(db as never, ORG, {
      source: "openfda",
      sourceId: "x",
      key: "cefazolin",
      genericName: "Cefazolin",
      status: "current",
      ndcs: [],
      rxcuis: [],
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.workflowId).toBe(`org-${ORG}-case-cefazolin`);
    expect(inserted[0]?.orgId).toBe(ORG);
  });
});

describe("listCasesAwaitingHuman", () => {
  it("bounds the read in the QUERY and keeps the longest-waiting end of the list", async () => {
    predicates.length = 0;
    orderings.length = 0;
    limits.length = 0;
    const { db } = fakeDb([{ key: "heparin sodium", status: "awaiting_review" }]);

    await listCasesAwaitingHuman(db as never, ORG, 25);

    // The cap belongs to the query, not only to whatever the caller renders: the daily brief runs
    // this once per tenant per day, and a tenant with a thousand parked cases would otherwise read
    // all thousand to show twenty-five.
    expect(limits).toEqual([25]);
    // Oldest first is what makes the cap keep the right end. Reversed, the bound would hide the
    // case parked for three weeks behind twenty-five opened this morning.
    expect(orderings[0]).toContain("opened_at");
    expect(orderings[0]).toContain("asc");
    expect(predicates[0]).toContain("org_id");
    expect(predicates[0]).toContain("status");
  });
});
