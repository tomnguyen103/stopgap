import { describe, expect, it } from "vitest";
import drugEnforcement from "./fixtures/openfda-drug-enforcement.json" with { type: "json" };
import deviceEnforcement from "./fixtures/openfda-device-enforcement.json" with { type: "json" };
import openfdaHeparin from "./fixtures/openfda-heparin.json" with { type: "json" };
import ashpFixture from "./fixtures/ashp-shortages.json" with { type: "json" };
import {
  DEFAULT_SIGNAL_CONFIDENCE,
  ENTITY_TYPES,
  RISK_DOMAINS,
  SEVERITIES,
  STALENESS,
  classifyStaleness,
  shortageSeverity,
  shortageStatusResolved,
  signalDedupeKey,
  type Connector,
  type NormalizationContext,
  type NormalizedSignal,
} from "./signal.js";
import { normalizeOpenFdaShortage, openFdaShortageConnector, type OpenFdaResponse } from "./openfda.js";
import { ashpEntries, ashpShortageConnector, normalizeAshpShortage, type AshpFeed } from "./ashp.js";
import {
  openFdaDeviceRecallConnector,
  openFdaDrugRecallConnector,
  recallResolved,
  recallSeverity,
  type OpenFdaEnforcementResponse,
} from "./openfda-recall.js";
import { dedupeSignals } from "./dedupe.js";

const CONTEXT: NormalizationContext = { orgId: "org_a", fetchedAt: "2026-07-28T00:00:00.000Z" };

const drugRecalls = (drugEnforcement as OpenFdaEnforcementResponse).results ?? [];
const deviceRecalls = (deviceEnforcement as OpenFdaEnforcementResponse).results ?? [];
const openFdaShortages = (openfdaHeparin as OpenFdaResponse).results ?? [];
const ashpShortages = ashpEntries(ashpFixture as AshpFeed);

/** Fail loudly on a fixture that lost the record a test is about, rather than on a null deref. */
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`fixture is missing ${label}`);
  return value;
}

const DRUG_RECALL = required(drugRecalls[0], "a drug recall");
const DEVICE_RECALL = required(deviceRecalls[0], "a device recall");
const OPENFDA_SHORTAGE = required(openFdaShortages[0], "an openFDA shortage");
const ASHP_SHORTAGE = required(ashpShortages[0], "an ASHP shortage");

/** Every adopted feed, paired with a recorded payload — the offline gate's whole surface. */
const CASES: { connector: Connector<never>; raws: unknown[] }[] = [
  { connector: openFdaShortageConnector as unknown as Connector<never>, raws: openFdaShortages },
  { connector: ashpShortageConnector as unknown as Connector<never>, raws: ashpShortages },
  { connector: openFdaDrugRecallConnector as unknown as Connector<never>, raws: drugRecalls },
  { connector: openFdaDeviceRecallConnector as unknown as Connector<never>, raws: deviceRecalls },
];

function normalizeAll(): NormalizedSignal[] {
  return CASES.flatMap(({ connector, raws }) =>
    raws.map((raw) => connector.normalize(raw as never, CONTEXT)),
  );
}

describe("the connector contract", () => {
  it("has a recorded payload behind every adopted feed", () => {
    expect(CASES.map((c) => c.connector.source)).toEqual([
      "openfda_shortage",
      "ashp_shortage",
      "openfda_drug_recall",
      "openfda_device_recall",
    ]);
    for (const { connector, raws } of CASES) expect(raws.length, connector.source).toBeGreaterThan(0);
  });

  it("emits one shape from every feed, with every contract field populated", () => {
    for (const signal of normalizeAll()) {
      expect(RISK_DOMAINS).toContain(signal.riskDomain);
      expect(ENTITY_TYPES).toContain(signal.entityType);
      expect(SEVERITIES).toContain(signal.severity);
      expect(STALENESS).toContain(signal.staleness);
      expect(signal.severityScore).toBeGreaterThan(0);
      expect(signal.severityScore).toBeLessThanOrEqual(1);
      expect(signal.sourceId).not.toBe("");
      expect(signal.entityIdentifier).not.toBe("");
      expect(signal.title).not.toBe("");
      expect(signal.summary).not.toBe("");
      expect(signal.evidenceUrl).toMatch(/^https:\/\//);
      expect(Number.isNaN(Date.parse(signal.observedAt))).toBe(false);
      expect(Number.isNaN(Date.parse(signal.publishedAt))).toBe(false);
      expect(signal.lastFetchedAt).toBe(CONTEXT.fetchedAt);
      expect(signal.raw).toBeDefined();
      expect(typeof signal.sourceResolved).toBe("boolean");
      expect(signal.matchHints).toMatchObject({
        ndcs: expect.any(Array),
        rxcuis: expect.any(Array),
        names: expect.any(Array),
      });
    }
  });

  it("declares each connector's domain and entity type consistently with what it emits", () => {
    for (const { connector, raws } of CASES) {
      for (const raw of raws) {
        const signal = connector.normalize(raw as never, CONTEXT);
        expect(signal.source).toBe(connector.source);
        expect(signal.riskDomain).toBe(connector.riskDomain);
        expect(signal.entityType).toBe(connector.entityType);
      }
    }
  });

  it("takes its confidence from the one shared constant, so scoring and matching cannot drift", () => {
    for (const signal of normalizeAll()) expect(signal.confidence).toBe(DEFAULT_SIGNAL_CONFIDENCE);
  });

  it("normalizes deterministically — a repeated payload yields a stable key and an equal signal", () => {
    for (const { connector, raws } of CASES) {
      for (const raw of raws) {
        expect(connector.normalize(raw as never, CONTEXT)).toEqual(
          connector.normalize(raw as never, CONTEXT),
        );
      }
    }
  });

  it("reads the fetch time from its caller rather than from the clock", () => {
    const later = openFdaDrugRecallConnector.normalize(DRUG_RECALL, {
      ...CONTEXT,
      fetchedAt: "2027-01-01T00:00:00.000Z",
    });
    const earlier = openFdaDrugRecallConnector.normalize(DRUG_RECALL, CONTEXT);
    expect(later.lastFetchedAt).toBe("2027-01-01T00:00:00.000Z");
    expect(later.publishedAt).toBe(earlier.publishedAt);
    expect(later.dedupeKey).toBe(earlier.dedupeKey);
  });
});

describe("dedupe on the contract's stable key", () => {
  it("scopes identity to organization and source", () => {
    const a = openFdaDrugRecallConnector.normalize(DRUG_RECALL, CONTEXT);
    const b = openFdaDrugRecallConnector.normalize(DRUG_RECALL, { ...CONTEXT, orgId: "org_b" });
    expect(a.dedupeKey).toBe(signalDedupeKey("org_a", "openfda_drug_recall", a.sourceId));
    expect(b.dedupeKey).not.toBe(a.dedupeKey);
    expect(signalDedupeKey("org_a", "openfda_shortage", "x")).not.toBe(
      signalDedupeKey("org_a", "ashp_shortage", "x"),
    );
  });

  it("collapses repeats of one record and unions their match hints", () => {
    const base = openFdaDrugRecallConnector.normalize(DRUG_RECALL, CONTEXT);
    const older: NormalizedSignal = {
      ...base,
      publishedAt: "2000-01-01T00:00:00.000Z",
      title: "stale copy",
      matchHints: { ...base.matchHints, ndcs: ["11111-111-11"] },
    };
    const merged = dedupeSignals([older, base]);
    expect(merged).toHaveLength(1);
    const only = required(merged[0], "the merged signal");
    expect(only.title).toBe(base.title);
    expect(only.matchHints.ndcs).toContain("11111-111-11");
  });

  it("keeps signals from different feeds apart rather than merging them by key collision", () => {
    const all = normalizeAll();
    expect(dedupeSignals(all)).toHaveLength(new Set(all.map((s) => s.dedupeKey)).size);
    expect(dedupeSignals(all).length).toBe(all.length);
  });
});

describe("source-resolved is not feed-absent", () => {
  it("keeps a terminated recall as a signal, flagged resolved rather than dropped", () => {
    const terminated = drugRecalls.find((r) => r.status === "Terminated");
    expect(terminated, "fixture must contain a terminated recall").toBeDefined();
    const signal = openFdaDrugRecallConnector.normalize(required(terminated, "a terminated recall"), CONTEXT);
    expect(signal.sourceResolved).toBe(true);
    expect(signal.severityScore).toBeGreaterThan(0);
    expect(dedupeSignals([signal])).toHaveLength(1);
  });

  it("treats an ongoing recall and an unknown-status shortage as unresolved", () => {
    const ongoing = deviceRecalls.find((r) => r.status === "Ongoing");
    expect(ongoing).toBeDefined();
    expect(
      openFdaDeviceRecallConnector.normalize(required(ongoing, "an ongoing recall"), CONTEXT).sourceResolved,
    ).toBe(false);
    expect(shortageStatusResolved("unknown")).toBe(false);
    expect(shortageStatusResolved("current")).toBe(false);
    expect(shortageStatusResolved("resolved")).toBe(true);
  });

  it("maps the provider's done states and nothing else", () => {
    expect(recallResolved("Terminated")).toBe(true);
    expect(recallResolved("Completed")).toBe(true);
    expect(recallResolved("Ongoing")).toBe(false);
    expect(recallResolved("Pending")).toBe(false);
    expect(recallResolved(undefined)).toBe(false);
  });
});

describe("severity", () => {
  it("carries the regulator's recall classification across instead of re-deriving it", () => {
    expect(recallSeverity("Class I")).toEqual({ severity: "critical", severityScore: 0.95 });
    expect(recallSeverity("Class II")).toEqual({ severity: "high", severityScore: 0.6 });
    expect(recallSeverity("Class III")).toEqual({ severity: "moderate", severityScore: 0.3 });
    expect(recallSeverity(undefined).severity).toBe("moderate");
  });

  it("ranks an unknown shortage above a resolved one", () => {
    expect(shortageSeverity("current").severityScore).toBeGreaterThan(
      shortageSeverity("unknown").severityScore,
    );
    expect(shortageSeverity("unknown").severityScore).toBeGreaterThan(
      shortageSeverity("resolved").severityScore,
    );
  });

  it("grades the recorded recalls by their own classification", () => {
    const device = openFdaDeviceRecallConnector.normalize(DEVICE_RECALL, CONTEXT);
    expect(device.severity).toBe("critical");
    expect(device.sourceId).toBe("Z-2372-2023");
    expect(device.entityType).toBe("device");
    expect(device.evidenceUrl).toContain("/device/enforcement.json?search=recall_number:");
  });
});

describe("staleness", () => {
  it("classifies by age and refuses to call an unparseable date fresh", () => {
    expect(classifyStaleness("2026-07-25T00:00:00.000Z", "2026-07-28T00:00:00.000Z")).toBe("fresh");
    expect(classifyStaleness("2026-07-10T00:00:00.000Z", "2026-07-28T00:00:00.000Z")).toBe("aging");
    expect(classifyStaleness("2026-01-10T00:00:00.000Z", "2026-07-28T00:00:00.000Z")).toBe("stale");
    expect(classifyStaleness("not a date", "2026-07-28T00:00:00.000Z")).toBe("stale");
    expect(classifyStaleness("2027-01-01T00:00:00.000Z", "2026-07-28T00:00:00.000Z")).toBe("stale");
  });

  it("marks the recorded 2015-era recall stale against a 2026 fetch", () => {
    expect(openFdaDrugRecallConnector.normalize(DRUG_RECALL, CONTEXT).staleness).toBe("stale");
  });
});

describe("the existing shortage feeds, refitted onto the contract", () => {
  it("keeps openFDA's stable source id — a status change must not rename the record", () => {
    const current = OPENFDA_SHORTAGE;
    const resolved = { ...current, status: "Resolved" };
    expect(normalizeOpenFdaShortage(resolved, CONTEXT).sourceId).toBe(
      normalizeOpenFdaShortage(current, CONTEXT).sourceId,
    );
    expect(normalizeOpenFdaShortage(resolved, CONTEXT).sourceResolved).toBe(true);
    expect(normalizeOpenFdaShortage(current, CONTEXT).sourceResolved).toBe(false);
  });

  it("carries openFDA identifiers through as match hints for later catalog association", () => {
    const signal = normalizeOpenFdaShortage(OPENFDA_SHORTAGE, CONTEXT);
    expect(signal.matchHints.ndcs.length + signal.matchHints.rxcuis.length).toBeGreaterThan(0);
    expect(signal.matchHints.names).toContain(signal.entityIdentifier);
  });

  it("keys an ASHP signal on the feed key, which lives outside the record", () => {
    const entry = ASHP_SHORTAGE;
    const signal = normalizeAshpShortage(entry, CONTEXT);
    expect(signal.sourceId).toBe(entry.key);
    expect(signal.dedupeKey).toBe(signalDedupeKey("org_a", "ashp_shortage", entry.key));
    expect(signal.raw).toBe(entry.shortage);
  });
});

describe("fetch stays separate from normalize", () => {
  it("normalizes every recorded payload with the network removed entirely", () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("a normalizer reached for the network");
    }) as unknown as typeof fetch;
    try {
      expect(normalizeAll().length).toBe(
        openFdaShortages.length + ashpShortages.length + drugRecalls.length + deviceRecalls.length,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns the raw provider results from a stubbed fetch, unnormalized", async () => {
    const stub = (async () =>
      new Response(JSON.stringify(deviceEnforcement), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const raws = await openFdaDeviceRecallConnector.fetch({ fetchImpl: stub });
    expect(raws).toHaveLength(deviceRecalls.length);
    expect(required(raws[0], "a fetched raw record")).not.toHaveProperty("dedupeKey");
  });

  it("treats openFDA's 404-for-empty as an empty result set, not a failure", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(openFdaDrugRecallConnector.fetch({ fetchImpl: notFound })).resolves.toEqual([]);
  });
});
