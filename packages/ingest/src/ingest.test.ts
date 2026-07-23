import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@stopgap/core/env";
import openfdaHeparin from "./fixtures/openfda-heparin.json" with { type: "json" };
import ashpFixture from "./fixtures/ashp-shortages.json" with { type: "json" };
import rxcuiHeparin from "./fixtures/rxnorm-rxcui-heparin.json" with { type: "json" };
import rxClasses5224 from "./fixtures/rxnorm-classes-5224.json" with { type: "json" };
import { mapOpenFdaResult, pollOpenFda, type OpenFdaResponse } from "./openfda.js";
import { mapAshpFeed, pollAshp, type AshpFeed } from "./ashp.js";
import { getRxcuiByName, getTherapeuticClasses } from "./rxnorm.js";
import { mergeRecords } from "./dedupe.js";
import { normalizeKey, normalizeStatus } from "./normalize.js";

/** Build a stub fetch that returns a fixed JSON body with a given status. */
function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

afterEach(() => {
  delete process.env.ASHP_AUTH_KEY;
  resetEnvCache();
});

describe("normalize", () => {
  it("collapses dosage-form noise into a stable cross-feed key", () => {
    expect(normalizeKey("Heparin Sodium Injection")).toBe("heparin sodium");
    expect(normalizeKey("Ketorolac Tromethamine Injection")).toBe("ketorolac tromethamine");
  });

  it("maps heterogeneous status strings to the enum", () => {
    expect(normalizeStatus("Current")).toBe("current");
    expect(normalizeStatus("Active")).toBe("current");
    expect(normalizeStatus("Resolved")).toBe("resolved");
    expect(normalizeStatus("No Longer Available")).toBe("unknown");
  });
});

describe("openFDA", () => {
  it("maps a live-shaped result into a ShortageRecord", () => {
    const first = (openfdaHeparin as OpenFdaResponse).results![0]!;
    const rec = mapOpenFdaResult(first);
    expect(rec.source).toBe("openfda");
    expect(rec.key).toBe("heparin sodium");
    expect(rec.status).toBe("current");
    expect(rec.rxcuis).toContain("1658690");
    expect(rec.ndcs.length).toBeGreaterThan(0);
  });

  it("polls the endpoint via injected fetch and returns all results", async () => {
    const recs = await pollOpenFda({ fetchImpl: stubFetch(openfdaHeparin) });
    expect(recs).toHaveLength((openfdaHeparin as OpenFdaResponse).results!.length);
  });

  it("treats a 404 as an empty result set (openFDA convention)", async () => {
    const recs = await pollOpenFda({ fetchImpl: stubFetch({}, 404) });
    expect(recs).toEqual([]);
  });
});

describe("ASHP", () => {
  it("maps the documented firebase feed shape into records", () => {
    const recs = mapAshpFeed(ashpFixture as AshpFeed);
    expect(recs).toHaveLength(3);
    const heparin = recs.find((r) => r.key === "heparin sodium");
    expect(heparin?.source).toBe("ashp");
    expect(heparin?.status).toBe("current");
    expect(heparin?.rxcuis).toContain("5224");
  });

  it("is stubbed (returns []) when no ASHP_AUTH_KEY is set", async () => {
    const recs = await pollAshp({ fetchImpl: stubFetch(ashpFixture) });
    expect(recs).toEqual([]);
  });

  it("polls the live feed when an auth key is present", async () => {
    process.env.ASHP_AUTH_KEY = "test-key";
    resetEnvCache();
    const recs = await pollAshp({ fetchImpl: stubFetch(ashpFixture) });
    expect(recs).toHaveLength(3);
  });
});

describe("RxNorm", () => {
  it("resolves rxcuis for a drug name", async () => {
    const ids = await getRxcuiByName("heparin", { fetchImpl: stubFetch(rxcuiHeparin) });
    expect(ids).toContain("5224");
  });

  it("resolves therapeutic classes for an rxcui, deduped", async () => {
    const classes = await getTherapeuticClasses("5224", { fetchImpl: stubFetch(rxClasses5224) });
    expect(classes.length).toBeGreaterThan(0);
    const ids = classes.map((c) => c.classId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("cross-feed dedupe", () => {
  it("merges openFDA + ASHP records for the same key into one shortage", () => {
    const openfda = mapOpenFdaResult((openfdaHeparin as OpenFdaResponse).results![0]!);
    const [ashpHeparin] = mapAshpFeed(ashpFixture as AshpFeed).filter((r) => r.key === "heparin sodium");
    const merged = mergeRecords([openfda, ashpHeparin!]);
    const heparin = merged.find((m) => m.key === "heparin sodium");
    expect(heparin?.sources.sort()).toEqual(["ashp", "openfda"]);
    // NDCs unioned across both feeds.
    expect(heparin!.ndcs.length).toBeGreaterThanOrEqual(openfda.ndcs.length);
    expect(heparin?.contributingRecords).toHaveLength(2);
  });

  it("keeps a case current if any feed still lists it, even when another says resolved", () => {
    const current = mapOpenFdaResult((openfdaHeparin as OpenFdaResponse).results![0]!);
    const resolved = { ...current, source: "ashp" as const, sourceId: "x", status: "resolved" as const };
    const [merged] = mergeRecords([resolved, current]);
    expect(merged!.status).toBe("current");
  });
});
