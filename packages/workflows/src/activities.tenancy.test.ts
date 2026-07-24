import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CROSS-TENANT COVERAGE FOR THE WORKER (PHASE6 §6.5), with no Postgres involved.
 *
 * `packages/db/src/rls.e2e.test.ts` proves the DATABASE refuses a cross-tenant row; it needs a live
 * server and is excluded from `pnpm gate`. This file asserts the layer above: that the activities
 * never ASK for one. `withOrgDb` is stubbed to record the org it was opened for, so an activity
 * that scoped to an ambient default — or to anything other than the org its workflow carries —
 * shows up here as the wrong id.
 *
 * The two properties under test:
 *
 *  1. a case activity scopes to `CaseInput.orgId` and to nothing else. There is no fallback and no
 *     "current org" to read, which is what makes cross-tenant access impossible to REQUEST rather
 *     than merely forbidden.
 *  2. the scheduled feed poll — the one path with no session and no case — opens ONE case per
 *     organization from ONE feed fetch. The external feed is a single shared fact; the case it
 *     produces is each tenant's own clinical work.
 */

const ORG_A = "aaaaaaaa-0000-0000-0000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-0000-0000-0000000000b1";

/** Orgs `withOrgDb` was opened for, in order. */
const scopedOrgIds: string[] = [];
/** Audit entries appended, so we can assert which tenant's chain they landed in. */
const audits: Record<string, unknown>[] = [];
/** `startCase` calls, as (orgId, key, existingWorkflowId). */
const startedCases: { orgId: string; key: string; workflowId: string | undefined }[] = [];
/** Case rows keyed by `${orgId}:${key}` — what `getCaseByKey` answers from. */
const caseRows = new Map<string, { id: string; workflowId: string; key: string }>();

vi.mock("@stopgap/db", () => ({
  withOrgDb: (orgId: string, fn: (db: unknown) => Promise<unknown>) => {
    scopedOrgIds.push(orgId);
    return fn({});
  },
  withBypassDb: (fn: (db: unknown) => Promise<unknown>) => fn({}),
  listOrganizations: async () => [
    { id: ORG_A, slug: "a", name: "A", createdAt: new Date() },
    { id: ORG_B, slug: "b", name: "B", createdAt: new Date() },
  ],
  getCaseByKey: async (_db: unknown, orgId: string, key: string) => caseRows.get(`${orgId}:${key}`),
  // The feed poll's batched prefetch: one query for all of this poll's keys, replacing the
  // per-(org, record) `getCaseByKey` that opened a transaction each time.
  getCasesByKeys: async (_db: unknown, orgId: string, keys: string[]) =>
    keys.flatMap((k) => {
      const row = caseRows.get(`${orgId}:${k}`);
      return row ? [{ ...row, orgId }] : [];
    }),
  isUserInOrg: async () => true,
  assertMaintenanceRoleBypassesRls: async () => undefined,
  appendAudit: async (_db: unknown, entry: Record<string, unknown>) => {
    audits.push(entry);
    return { hash: "h" };
  },
  upsertCaseForRecord: async (_db: unknown, orgId: string, record: { key: string }) => {
    const row = { id: `case-${orgId}-${record.key}`, workflowId: `org-${orgId}-case-x`, key: record.key };
    caseRows.set(`${orgId}:${record.key}`, row);
    return row;
  },
  updateCaseStatus: async () => undefined,
  listOpenMonitoringCases: async () => [],
  recordFeedRecords: async () => undefined,
  resetFeedMiss: async () => undefined,
  bumpFeedMiss: async () => undefined,
  listRoleRecipients: async () => [],
  recordAcknowledgment: async () => true,
  getApprovedProtocol: async () => undefined,
  draftProtocolVersion: async () => ({ id: "v1", version: 1 }),
  approveProtocolVersion: async () => ({ row: { version: 1 }, changed: true }),
  getEscalationPolicy: async () => undefined,
  getSyntheticUser: (which: string) => `synthetic-${which}`,
  syntheticUserIdForLabel: () => undefined,
  anchorAuditChain: async () => [],
  workflowIdForKey: (orgId: string, key: string) => `org-${orgId}-case-${key}`,
  getDb: () => ({}),
}));

vi.mock("@stopgap/core/env", () => ({ getEnv: () => ({ FEED_RESOLVE_MISS_THRESHOLD: 3 }) }));

// The feed returns ONE snapshot for the whole deployment — the fetch must not repeat per tenant.
let openFdaCalls = 0;
vi.mock("@stopgap/ingest", () => ({
  pollOpenFda: async () => {
    openFdaCalls += 1;
    return [
      {
        source: "openfda",
        sourceId: "s1",
        key: "heparin",
        genericName: "Heparin",
        status: "current",
        ndcs: [],
        rxcuis: [],
        sources: ["openfda"],
      },
    ];
  },
  pollAshp: async () => [],
  mergeRecords: (rows: unknown[]) => rows,
  contentHash: () => "hash",
}));

vi.mock("@stopgap/comms", () => ({ sendEmail: async () => ({ channel: "email", delivered: false }), sendEhrFlag: async () => ({ channel: "ehr", delivered: false }) }));
vi.mock("@stopgap/observability", () => ({ incrementCounter: () => undefined }));
vi.mock("@stopgap/agents", () => ({ assessImpact: async () => ({}), researchAlternatives: async () => ({}) }));

vi.mock("./client.js", () => ({
  makeClient: async () => ({ client: {}, connection: { close: async () => undefined } }),
  markResolved: async () => undefined,
  startCase: async (
    _client: unknown,
    orgId: string,
    record: { key: string },
    _sources: unknown,
    existingWorkflowId?: string,
  ) => {
    startedCases.push({ orgId, key: record.key, workflowId: existingWorkflowId });
    return { workflowId: existingWorkflowId ?? `org-${orgId}-case-${record.key}`, started: true };
  },
}));

// The activity context is only read for a run id; outside Temporal there is none.
vi.mock("@temporalio/activity", () => ({
  Context: { current: () => ({ info: { workflowExecution: { runId: "run-1" } } }) },
}));

const { recordDetected, persistStatus, pollAndOpenCases } = await import("./activities.js");

beforeEach(() => {
  scopedOrgIds.length = 0;
  audits.length = 0;
  startedCases.length = 0;
  caseRows.clear();
  openFdaCalls = 0;
});

describe("a case activity scopes to the workflow's org", () => {
  const record = {
    source: "openfda" as const,
    sourceId: "s1",
    key: "heparin",
    genericName: "Heparin",
    status: "current" as const,
    ndcs: [],
    rxcuis: [],
  };

  it("recordDetected opens its transaction in CaseInput.orgId and audits into that chain", async () => {
    await recordDetected({ orgId: ORG_B, record, sources: ["openfda"] });
    expect(scopedOrgIds).toEqual([ORG_B]);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.orgId).toBe(ORG_B);
    // Nothing about the seed org, and nothing about org A: the org came from the input and there
    // is no other source it could have come from.
    expect(scopedOrgIds).not.toContain(ORG_A);
    expect(scopedOrgIds).not.toContain("00000000-0000-0000-0000-0000000000a1");
  });

  it("persistStatus scopes to the org it is given, for the SAME key in two tenants", async () => {
    caseRows.set(`${ORG_A}:heparin`, { id: "case-a", workflowId: "case-heparin", key: "heparin" });
    caseRows.set(`${ORG_B}:heparin`, { id: "case-b", workflowId: `org-${ORG_B}-case-heparin`, key: "heparin" });
    await persistStatus(ORG_A, "heparin", "monitoring");
    await persistStatus(ORG_B, "heparin", "monitoring");
    expect(scopedOrgIds).toEqual([ORG_A, ORG_B]);
    // Two hospitals short on the same drug produce two independent audit trails. Org A's row here
    // deliberately carries the LEGACY `case-heparin` workflow id, which the activity finds because
    // it looks the case up by KEY rather than by a recomputed id.
    expect(audits.map((a) => [a.orgId, a.caseId])).toEqual([
      [ORG_A, "case-a"],
      [ORG_B, "case-b"],
    ]);
  });
});

describe("the scheduled feed poll (no session, no case)", () => {
  it("fetches the feed ONCE and opens one case PER ORGANIZATION", async () => {
    const result = await pollAndOpenCases();
    // One external fetch: an openFDA snapshot is one physical fact about the drug supply,
    // identical for every hospital, so re-fetching per tenant would multiply the load for nothing.
    expect(openFdaCalls).toBe(1);
    // One case per tenant: the CONSEQUENCE of that shared fact is each hospital's own clinical work.
    expect(startedCases.map((c) => c.orgId)).toEqual([ORG_A, ORG_B]);
    expect(startedCases.every((c) => c.key === "heparin")).toBe(true);
    expect(result.opened).toBe(2);
    // Every tenant transaction the poll opened named a real org from the registry — never a
    // default, and never one org's scope used for another org's work.
    expect(new Set(scopedOrgIds)).toEqual(new Set([ORG_A, ORG_B]));
  });

  it("reuses an existing case's STORED workflow id rather than minting a new one", async () => {
    // Org A already has a case opened before ids became org-qualified.
    caseRows.set(`${ORG_A}:heparin`, { id: "case-a", workflowId: "case-heparin", key: "heparin" });
    await pollAndOpenCases();
    const a = startedCases.find((c) => c.orgId === ORG_A);
    const b = startedCases.find((c) => c.orgId === ORG_B);
    // Org A: the legacy id is passed through, so the poll addresses the execution that exists.
    expect(a?.workflowId).toBe("case-heparin");
    // Org B has no case yet, so `startCase` mints the new org-qualified id itself.
    expect(b?.workflowId).toBeUndefined();
  });
});
