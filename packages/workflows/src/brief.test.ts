import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyBriefInput } from "@stopgap/db";

/**
 * The daily brief (ticket 13), with no Postgres and no provider involved.
 *
 * What is worth asserting here is not the prose — a model writes that — but the four properties
 * that decide whether the brief is trustworthy at all: it is written PER TENANT from that tenant's
 * own rows, a provider outage DEGRADES rather than disappears, text the compliance guard refuses is
 * never stored, and one tenant's failure does not stop the schedule for the rest.
 */

const ORG_A = "aaaaaaaa-0000-0000-0000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-0000-0000-0000000000b1";

/** Orgs `withOrgDb` was opened for, in order. */
const scopedOrgIds: string[] = [];
/** Brief rows written, as (orgId, input). */
const written: { orgId: string; input: DailyBriefInput }[] = [];
/** Orgs whose signal read should throw, to prove per-tenant containment. */
const failingReads = new Set<string>();
/** `briefDate` values `previousDailyBrief` was asked for — proof today's own row is excluded. */
const previousBriefDates: string[] = [];
/** The input the model was handed, so the ordering it promises can be asserted. */
const draftInputs: { current: { entity: string; score: number | undefined }[] }[] = [];
/** Set to make the model call throw, standing in for a total provider outage. */
let providerDown = false;
/** What the model "wrote" this run. */
let draftHeadline = "Two shortages eased, one new device recall.";

vi.mock("@stopgap/db", () => ({
  withBypassDb: (fn: () => unknown) => fn(),
  withOrgDb: (orgId: string, fn: (db: unknown) => unknown) => {
    scopedOrgIds.push(orgId);
    return fn({ orgId });
  },
  listOrganizations: () => [{ id: ORG_A }, { id: ORG_B }],
  listSignals: (_db: unknown, orgId: string) => {
    if (failingReads.has(orgId)) throw new Error("signal read failed");
    return [
      // Deliberately in the WRONG order for a brief: `listSignals` orders by publication date,
      // and the brief promises the model highest-risk-first. Only the scorer's snapshot can
      // reorder these, which is what the ranking assertion below checks.
      {
        id: "sig-low",
        entityIdentifier: "aminophylline",
        riskDomain: "shortage",
        severity: "low",
        severityScore: "0.90",
        title: "Minor shortage",
        dedupeKey: `key-low-${orgId.slice(0, 4)}`,
      },
      {
        id: "sig-high",
        entityIdentifier: "cefazolin",
        riskDomain: "shortage",
        severity: "high",
        severityScore: "0.10",
        title: "Injectable shortage",
        dedupeKey: `key-high-${orgId.slice(0, 4)}`,
      },
    ];
  },
  latestScoresForSignals: () =>
    new Map([
      ["sig-low", { score: 12, band: "low", scorerVersion: "v1" }],
      ["sig-high", { score: 88, band: "high", scorerVersion: "v1" }],
    ]),
  previousDailyBrief: (_db: unknown, _orgId: string, briefDate: string) => {
    previousBriefDates.push(briefDate);
    return undefined;
  },
  listCasesAwaitingHuman: () => [{ key: "case-1", status: "awaiting_review" }],
  recordDailyBrief: (_db: unknown, orgId: string, input: DailyBriefInput) => {
    written.push({ orgId, input });
    return { id: "row", orgId, ...input };
  },
}));

vi.mock("@stopgap/agents", () => ({
  draftDailyBrief: (input: { current: { entity: string; score: number | undefined }[] }) => {
    draftInputs.push(input);
    if (providerDown) throw new Error("all providers unhealthy");
    return {
      brief: { headline: draftHeadline, changes: ["a"], newlyAtRisk: ["b"], needsReview: ["c"] },
      model: "gemini:gemini-2.5-flash-lite",
    };
  },
}));

vi.mock("@stopgap/compliance", async () => {
  const actual = await vi.importActual<typeof import("@stopgap/compliance")>("@stopgap/compliance");
  return actual;
});

const { generateDailyBriefs } = await import("./brief.js");

beforeEach(() => {
  scopedOrgIds.length = 0;
  written.length = 0;
  previousBriefDates.length = 0;
  draftInputs.length = 0;
  failingReads.clear();
  providerDown = false;
  draftHeadline = "Two shortages eased, one new device recall.";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("generateDailyBriefs", () => {
  it("writes one brief per tenant, each scoped to that tenant", async () => {
    const result = await generateDailyBriefs(new Date("2026-03-04T06:00:00Z"));

    expect(result).toEqual({ generated: 2, degraded: 0 });
    expect(written.map((w) => w.orgId)).toEqual([ORG_A, ORG_B]);
    // Every scope opened is one of the two tenants — never an ambient default.
    expect(new Set(scopedOrgIds)).toEqual(new Set([ORG_A, ORG_B]));
    // The signal keys stored are the ones read under that same tenant's scope.
    expect(written[0]?.input.signalKeys).toEqual([
      `key-high-${ORG_A.slice(0, 4)}`,
      `key-low-${ORG_A.slice(0, 4)}`,
    ]);
    expect(written[1]?.input.signalKeys).toEqual([
      `key-high-${ORG_B.slice(0, 4)}`,
      `key-low-${ORG_B.slice(0, 4)}`,
    ]);
  });

  it("dates the brief in UTC, so two tenants agree which day it covers", async () => {
    await generateDailyBriefs(new Date("2026-03-04T23:30:00Z"));
    expect(written.every((w) => w.input.briefDate === "2026-03-04")).toBe(true);
  });

  it("ranks by the deterministic scorer, not by the signal row's ingest heuristic", async () => {
    await generateDailyBriefs(new Date("2026-03-04T06:00:00Z"));

    // `severityScore` on the row would have put aminophylline (0.90) first. The scorer's snapshot
    // puts cefazolin (88) first, and the model is told it is reading highest-risk-first.
    expect(draftInputs[0]?.current.map((s) => s.entity)).toEqual(["cefazolin", "aminophylline"]);
    expect(draftInputs[0]?.current.map((s) => s.score)).toEqual([88, 12]);
  });

  it("measures 'what changed' against a brief from a PREVIOUS day, never today's own row", async () => {
    await generateDailyBriefs(new Date("2026-03-04T06:00:00Z"));
    // A same-day re-run upserts; reading the day's own row back would collapse every diff to zero.
    expect(previousBriefDates).toEqual(["2026-03-04", "2026-03-04"]);
  });

  it("records the model that wrote it", async () => {
    await generateDailyBriefs(new Date("2026-03-04T06:00:00Z"));
    expect(written[0]?.input.model).toBe("gemini:gemini-2.5-flash-lite");
  });

  it("degrades rather than disappears when no provider can be reached", async () => {
    providerDown = true;
    const result = await generateDailyBriefs(new Date("2026-03-04T06:00:00Z"));

    expect(result).toEqual({ generated: 0, degraded: 2 });
    // The row still lands, saying WHY. A director who sees nothing cannot tell "nothing happened"
    // from "we could not write it".
    expect(written).toHaveLength(2);
    expect(written[0]?.input.degradedReason).toBe("provider_unavailable");
    expect(written[0]?.input.model).toBeNull();
    expect(written[0]?.input.changes).toEqual([]);
  });

  it("never stores text the compliance guard refuses", async () => {
    draftHeadline = "Switch the patient to the cefazolin alternative while stock is short.";
    const result = await generateDailyBriefs(new Date("2026-03-04T06:00:00Z"));

    expect(result).toEqual({ generated: 0, degraded: 2 });
    expect(written[0]?.input.degradedReason).toBe("compliance_blocked");
    // The refused sentence is not in the row — the guard runs BEFORE the write, not before display.
    expect(JSON.stringify(written[0]?.input)).not.toContain("Switch the patient");
  });

  it("keeps one tenant's failure from stopping the schedule for the rest", async () => {
    failingReads.add(ORG_A);
    const result = await generateDailyBriefs(new Date("2026-03-04T06:00:00Z"));

    expect(result).toEqual({ generated: 1, degraded: 0 });
    expect(written.map((w) => w.orgId)).toEqual([ORG_B]);
  });
});
