import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCORER_VERSION } from "@stopgap/scorer";
import type { OpenMonitoringCase } from "@stopgap/db";

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
/** Open monitoring cases per org — what the feed-resolution half of the poll works from. */
const openMonitoringCases = new Map<string, OpenMonitoringCase[]>();
/** Workflow ids `markResolved` refuses to signal (a completed/terminated/aged-out execution). */
const unsignalableWorkflowIds = new Set<string>();
/** Workflow ids `markResolved` was asked to signal, in order. */
const signalledWorkflowIds: string[] = [];
/** Counters incremented, so the failure path can be asserted as recorded rather than swallowed. */
const counters: string[] = [];
/** Signals written per org (ticket 06) — proof the poll normalizes PER TENANT, not once. */
const writtenSignals: { orgId: string; dedupeKeys: string[] }[] = [];
/** The sources each org's miss sweep was scoped to, so an outage cannot retire live signals. */
const missSweeps: { orgId: string; sources: string[] }[] = [];
/** Score snapshots written per org (ticket 07) — scoring rides the poll, not a second runtime. */
const writtenSnapshots: { orgId: string; count: number; scorerVersion: string | undefined }[] = [];
/** Evidence artifacts written per org (ticket 09) — a pointer and a fingerprint, never content. */
const writtenEvidence: { orgId: string; entries: Record<string, unknown>[] }[] = [];

vi.mock("@stopgap/db", () => ({
  withOrgDb: (orgId: string, fn: (db: unknown) => Promise<unknown>) => {
    scopedOrgIds.push(orgId);
    return fn({});
  },
  withBypassDb: (fn: (db: unknown) => Promise<unknown>) => fn({}),
  // The real collapse, not a stub: the poll relies on it to keep two feed records that derive one
  // dedupe key from becoming two snapshot rows with the same conflict target.
  dedupeByKey: <T extends { dedupeKey: string }>(signals: T[]): T[] => {
    const byKey = new Map<string, T>();
    for (const signal of signals) byKey.set(signal.dedupeKey, signal);
    return [...byKey.values()];
  },
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
  upsertSignals: async (_db: unknown, orgId: string, signals: { dedupeKey: string }[]) => {
    writtenSignals.push({ orgId, dedupeKeys: signals.map((s) => s.dedupeKey) });
    return signals.map((s, i) => ({ id: `sig-${orgId}-${i}`, dedupeKey: s.dedupeKey }));
  },
  recordEvidence: async (_db: unknown, orgId: string, entries: Record<string, unknown>[]) => {
    writtenEvidence.push({ orgId, entries });
    return entries.length;
  },
  // Ticket 16 — the poll matches each signal against the tenant's catalog before scoring. Stubbed
  // to "this tenant has no catalog", which is the state every existing assertion here was written
  // under: the catalog components stay unavailable and the totals are unchanged.
  matchSignalToCatalog: async () => [],
  catalogExposure: async () => ({ soleSourcedItemIds: [] }),
  recordScoreSnapshots: async (
    _db: unknown,
    orgId: string,
    snapshots: { scorerVersion: string }[],
  ) => {
    writtenSnapshots.push({
      orgId,
      count: snapshots.length,
      scorerVersion: snapshots[0]?.scorerVersion,
    });
    return snapshots.length;
  },
  bumpSignalFeedMiss: async (
    _db: unknown,
    orgId: string,
    _seen: string[],
    _run: string,
    sources: string[],
  ) => {
    missSweeps.push({ orgId, sources });
    return 0;
  },
  listAlertRules: async () => [],
  lastFiredByRule: async () => ({}),
  recordAlertEvents: async () => [],
  recordAlertDeliveries: async () => undefined,
  isUserInOrg: async () => true,
  assertMaintenanceRoleBypassesRls: async () => undefined,
  appendAudit: async (_db: unknown, entry: Record<string, unknown>) => {
    audits.push(entry);
    return { hash: "h" };
  },
  upsertCaseForRecord: async (_db: unknown, orgId: string, record: { key: string }) => {
    const row = {
      id: `case-${orgId}-${record.key}`,
      workflowId: `org-${orgId}-case-x`,
      key: record.key,
    };
    caseRows.set(`${orgId}:${record.key}`, row);
    return row;
  },
  updateCaseStatus: async () => undefined,
  listOpenMonitoringCases: async (_db: unknown, orgId: string) =>
    openMonitoringCases.get(orgId) ?? [],
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
const HEPARIN_RECORD = {
  source: "openfda",
  sourceId: "s1",
  key: "heparin",
  genericName: "Heparin",
  status: "current",
  ndcs: [],
  rxcuis: [],
  sources: ["openfda"],
};
/** One normalized signal per org, so the per-tenant write can be counted. */
function stubSignal(orgId: string, fetchedAt: string) {
  return {
    source: "openfda_shortage",
    sourceId: "s1",
    riskDomain: "shortage",
    entityType: "drug",
    entityIdentifier: "Heparin",
    title: "Drug shortage — Heparin",
    summary: "s",
    severity: "high",
    severityScore: 0.7,
    confidence: 0.8,
    observedAt: fetchedAt,
    publishedAt: fetchedAt,
    lastFetchedAt: fetchedAt,
    staleness: "fresh",
    sourceResolved: false,
    evidenceUrl: "https://example.test/e",
    raw: {},
    dedupeKey: `${orgId}:openfda_shortage:s1`,
    matchHints: { ndcs: [], rxcuis: [], names: ["Heparin"] },
  };
}
vi.mock("@stopgap/ingest", () => ({
  openFdaShortageConnector: {
    source: "openfda_shortage",
    fetch: async () => {
      openFdaCalls += 1;
      return [{ generic_name: "Heparin" }];
    },
    normalize: (_raw: unknown, ctx: { orgId: string; fetchedAt: string }) =>
      stubSignal(ctx.orgId, ctx.fetchedAt),
  },
  // Returns nothing — so the poll must NOT vouch for it in the miss sweep. An empty answer is
  // indistinguishable from a quiet failure (ASHP answers `[]` with no auth key).
  ashpShortageConnector: { source: "ashp_shortage", fetch: async () => [], normalize: () => null },
  openFdaDrugRecallConnector: {
    source: "openfda_drug_recall",
    fetch: async () => [],
    normalize: () => null,
  },
  openFdaDeviceRecallConnector: {
    source: "openfda_device_recall",
    fetch: async () => [],
    normalize: () => null,
  },
  mapOpenFdaResult: () => HEPARIN_RECORD,
  mapAshpShortage: () => HEPARIN_RECORD,
  mergeRecords: (rows: unknown[]) => rows,
  contentHash: () => "hash",
}));

vi.mock("@stopgap/comms", () => ({
  sendEmail: async () => ({ channel: "email", delivered: false }),
  sendEhrFlag: async () => ({ channel: "ehr", delivered: false }),
}));
vi.mock("@stopgap/observability", () => ({
  incrementCounter: (name: string) => {
    counters.push(name);
  },
}));
vi.mock("@stopgap/agents", () => ({
  assessImpact: async () => ({}),
  researchAlternatives: async () => ({}),
}));

vi.mock("./client.js", () => ({
  makeClient: async () => ({ client: {}, connection: { close: async () => undefined } }),
  markResolved: async (_client: unknown, workflowId: string) => {
    signalledWorkflowIds.push(workflowId);
    if (unsignalableWorkflowIds.has(workflowId)) {
      // What Temporal raises when the execution is gone — completed, terminated, or dropped by
      // retention — while the case row is still in a monitoring status.
      throw new Error(`workflow execution not found: ${workflowId}`);
    }
  },
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
  openMonitoringCases.clear();
  unsignalableWorkflowIds.clear();
  signalledWorkflowIds.length = 0;
  counters.length = 0;
  writtenSignals.length = 0;
  missSweeps.length = 0;
  writtenSnapshots.length = 0;
  writtenEvidence.length = 0;
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
    caseRows.set(`${ORG_B}:heparin`, {
      id: "case-b",
      workflowId: `org-${ORG_B}-case-heparin`,
      key: "heparin",
    });
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

  /**
   * Ticket 06 — a signal is the tenant's INTERPRETATION of a shared fact.
   *
   * One fetch, N normalizations: the dedupe key is org-scoped, so org A's heparin signal and
   * org B's are different rows even though the openFDA payload behind them is byte-identical.
   * A single shared normalization would give both hospitals one key and one row, which is the
   * cross-tenant collision the whole contract exists to prevent.
   */
  it("writes each tenant its OWN signal from the one deployment-wide fetch", async () => {
    await pollAndOpenCases();
    expect(openFdaCalls).toBe(1);
    expect(writtenSignals.map((w) => w.orgId)).toEqual([ORG_A, ORG_B]);
    expect(writtenSignals[0]?.dedupeKeys).toEqual([`${ORG_A}:openfda_shortage:s1`]);
    expect(writtenSignals[1]?.dedupeKeys).toEqual([`${ORG_B}:openfda_shortage:s1`]);
  });

  /**
   * A feed OUTAGE is not a feed saying the hazard ended.
   *
   * The miss sweep is scoped to the feeds this poll can VOUCH for — the ones that returned at
   * least one row. ASHP answers `[]` with no auth key and openFDA answers 404 for an empty result
   * set exactly as it does for a bad path, so "returned nothing" cannot be told apart from
   * "failed quietly", and treating it as absence would retire live signals on a key expiry.
   */
  /**
   * Ticket 07 — scores are produced BY THE POLL, not by a second orchestrator.
   *
   * The snapshot rides the same per-org transaction as the signal write, so it can never describe
   * a row that failed to land, and every org in one poll shares an evaluation timestamp — which is
   * what makes two tenants' scores comparable rather than merely both present.
   */
  it("writes a scored snapshot for each signal, in the same tenant transaction", async () => {
    await pollAndOpenCases();
    expect(writtenSnapshots.map((w) => w.orgId)).toEqual([ORG_A, ORG_B]);
    expect(writtenSnapshots.every((w) => w.count === 1)).toBe(true);
    // Version-pinned, so a score is reproducible after the weights move.
    expect(writtenSnapshots[0]?.scorerVersion).toBe(SCORER_VERSION);
  });

  /**
   * Ticket 09 — the evidence trail is a POINTER and a FINGERPRINT, never content.
   *
   * A table whose purpose is long retention must not be where a hospital discovers it is holding
   * provider text it now has to treat as protected. The assertion is deliberately about what is
   * ABSENT: no payload, no body, no excerpt.
   */
  it("records evidence per signal without retaining any provider content", async () => {
    await pollAndOpenCases();
    expect(writtenEvidence.map((w) => w.orgId)).toEqual([ORG_A, ORG_B]);
    const entry = writtenEvidence[0]?.entries[0] ?? {};
    expect(Object.keys(entry).sort()).toEqual([
      "capturedAt",
      "contentHash",
      "originUrl",
      "signalId",
      "source",
      "sourceId",
      "type",
    ]);
    expect(entry.type).toBe("provider_record");
    expect(JSON.stringify(entry)).not.toMatch(/payload|"raw"|body/i);
  });

  it("sweeps misses only for feeds that returned something, never for a silent one", async () => {
    await pollAndOpenCases();
    for (const sweep of missSweeps) {
      // ONLY openFDA shortages returned a row, so it is the only source the poll can tell apart
      // from a broken one. A feed that answered with nothing is left out rather than having its
      // signals counted as missing.
      expect(sweep.sources).toEqual(["openfda_shortage"]);
    }
    expect(missSweeps.map((s) => s.orgId)).toEqual([ORG_A, ORG_B]);
  });

  /**
   * ONE UNSIGNALABLE CASE MUST NOT STOP THE POLL.
   *
   * `markResolved` signals a Temporal execution that may no longer exist — completed, terminated,
   * or aged out of retention — while the case row still sits in a monitoring status. Unguarded,
   * that rejection escapes `pollAndOpenCases`, so every org LATER in the loop gets no case opened
   * and no resolution that cycle, `stopgap_feed_poll_success_total` never increments, and the
   * FeedStale runbook reads "the poller stopped" for what is one stale row in one tenant. The
   * escalation ladder already contains exactly this hazard per tier; this asserts the poll does too.
   */
  it("keeps polling when one case's resolution signal fails, and records the failure", async () => {
    const monitoring = (caseId: string, workflowId: string, key: string): OpenMonitoringCase => ({
      caseId,
      workflowId,
      key,
      source: "openfda",
      sourceId: "s0",
      // Threshold is 3, so one more miss this poll crosses it and the case resolves.
      feedMissCount: 2,
    });
    // Org A comes FIRST in the registry, and its first case is the one whose execution is gone.
    openMonitoringCases.set(ORG_A, [
      monitoring("case-a-dead", "org-a-case-aspirin", "aspirin"),
      monitoring("case-a-live", "org-a-case-insulin", "insulin"),
    ]);
    openMonitoringCases.set(ORG_B, [monitoring("case-b-live", "org-b-case-warfarin", "warfarin")]);
    unsignalableWorkflowIds.add("org-a-case-aspirin");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await pollAndOpenCases();
    // Logged with the case it belongs to, so the failure is diagnosable rather than a silent drop.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("case-a-dead");
    logged.mockRestore();

    // Every case was still attempted — the failure did not short-circuit its own org, let alone
    // the tenants after it.
    expect(signalledWorkflowIds).toEqual([
      "org-a-case-aspirin",
      "org-a-case-insulin",
      "org-b-case-warfarin",
    ]);
    // Two resolved, and the failed one is NOT counted: reporting it as resolved would be the faked
    // success this codebase refuses.
    expect(result.resolved).toBe(2);
    expect(audits.filter((a) => a.action === "case.feed_resolved").map((a) => a.caseId)).toEqual([
      "case-a-live",
      "case-b-live",
    ]);
    // The rest of the poll's work still happened for BOTH tenants.
    expect(startedCases.map((c) => c.orgId)).toEqual([ORG_A, ORG_B]);
    // Contained, not swallowed: the failure is counted, and the poll still reports its own success.
    expect(counters).toContain("stopgap_feed_resolution_failures_total");
    expect(counters).toContain("stopgap_feed_poll_success_total");
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
