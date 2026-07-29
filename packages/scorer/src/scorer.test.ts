import { describe, expect, it } from "vitest";
import {
  BAND_THRESHOLDS,
  COMPONENT_BUDGET,
  FRESHNESS_FLOOR,
  SCORER_VERSION,
  SCORE_BANDS,
  SOURCE_RESOLVED_FACTOR,
  bandFor,
  componentsToRecord,
  domainRankWeight,
  freshnessFactor,
  scoreSignals,
  type ScorableSignal,
} from "./index.js";

const AT = "2026-07-28T00:00:00.000Z";

function signal(over: Partial<ScorableSignal> = {}): ScorableSignal {
  return {
    dedupeKey: "org:openfda_shortage:s1",
    source: "openfda_shortage",
    riskDomain: "shortage",
    severity: "high",
    severityScore: 0.7,
    confidence: 0.8,
    publishedAt: AT,
    sourceResolved: false,
    ...over,
  };
}

/** Every component's points, by name. */
function points(result: ReturnType<typeof scoreSignals>) {
  return Object.fromEntries(result.components.map((c) => [c.name, c.points]));
}

describe("determinism", () => {
  it("gives an identical result for identical inputs and an identical timestamp", () => {
    const input = { signals: [signal(), signal({ dedupeKey: "k2" })], evaluatedAt: AT };
    expect(scoreSignals(input)).toEqual(scoreSignals(input));
  });

  it("does not depend on the order signals arrive in", () => {
    const a = signal({ dedupeKey: "a", riskDomain: "shortage" });
    const b = signal({ dedupeKey: "b", riskDomain: "recall", severityScore: 0.95 });
    const forwards = scoreSignals({ signals: [a, b], evaluatedAt: AT });
    const backwards = scoreSignals({ signals: [b, a], evaluatedAt: AT });
    // The WHOLE result, not only the score: the audit record is what a reader compares two
    // evaluations with, and arrival order leaking into it makes two identical exposures look
    // different.
    expect(forwards).toEqual(backwards);
  });

  it("emits the audited signal keys in a stable order whatever order they arrived in", () => {
    const a = signal({ dedupeKey: "org:z-last" });
    const b = signal({ dedupeKey: "org:a-first" });
    expect(scoreSignals({ signals: [a, b], evaluatedAt: AT }).audit.signalKeys).toEqual([
      "org:a-first",
      "org:z-last",
    ]);
    expect(scoreSignals({ signals: [b, a], evaluatedAt: AT }).audit.signalKeys).toEqual([
      "org:a-first",
      "org:z-last",
    ]);
  });

  it("never reads the clock — a later evaluation of an old signal scores lower, not differently", () => {
    const old = signal({ publishedAt: "2026-01-01T00:00:00.000Z" });
    const near = scoreSignals({ signals: [old], evaluatedAt: "2026-01-08T00:00:00.000Z" });
    const far = scoreSignals({ signals: [old], evaluatedAt: "2027-01-08T00:00:00.000Z" });
    expect(far.score).toBeLessThan(near.score);
  });
});

describe("monotonicity", () => {
  it("adding a matched signal never lowers the total", () => {
    let previous = 0;
    const signals: ScorableSignal[] = [];
    for (let i = 0; i < 6; i++) {
      signals.push(signal({ dedupeKey: `k${i}`, severityScore: 0.1 + i * 0.1 }));
      const score = scoreSignals({ signals, evaluatedAt: AT }).score;
      expect(score, `after ${i + 1} signals`).toBeGreaterThanOrEqual(previous);
      previous = score;
    }
  });

  it("adding a matched risk domain never lowers the total, and adds strictly", () => {
    const shortageOnly = scoreSignals({ signals: [signal()], evaluatedAt: AT });
    const both = scoreSignals({
      signals: [signal(), signal({ dedupeKey: "r", riskDomain: "recall" })],
      evaluatedAt: AT,
    });
    expect(both.score).toBeGreaterThan(shortageOnly.score);
  });

  it("pays a second domain LESS than the first, so two hazards are not twice one", () => {
    const one = scoreSignals({ signals: [signal()], evaluatedAt: AT }).score;
    const two = scoreSignals({
      signals: [signal(), signal({ dedupeKey: "r", riskDomain: "recall" })],
      evaluatedAt: AT,
    }).score;
    expect(two - one).toBeLessThan(one);
    expect(two - one).toBeGreaterThan(0);
  });

  it("keeps a weak signal from outranking a severe one, however many there are", () => {
    const weak = Array.from({ length: 50 }, (_, i) =>
      signal({ dedupeKey: `w${i}`, severityScore: 0.05, confidence: 0.2 }),
    );
    const severe = [signal({ severityScore: 1, confidence: 1 })];
    expect(scoreSignals({ signals: weak, evaluatedAt: AT }).score).toBeLessThan(
      scoreSignals({ signals: severe, evaluatedAt: AT }).score,
    );
  });

  it("caps the signal component at its budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => [
      signal({ dedupeKey: `s${i}`, severityScore: 1, confidence: 1 }),
      signal({ dedupeKey: `r${i}`, riskDomain: "recall", severityScore: 1, confidence: 1 }),
    ]).flat();
    const result = scoreSignals({ signals: many, evaluatedAt: AT });
    expect(points(result).signalExposure).toBeLessThanOrEqual(COMPONENT_BUDGET.signalExposure);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("a source-resolved hazard is decayed, not dropped", () => {
  it("still contributes, and contributes less", () => {
    const live = scoreSignals({ signals: [signal()], evaluatedAt: AT }).score;
    const resolved = scoreSignals({
      signals: [signal({ sourceResolved: true })],
      evaluatedAt: AT,
    }).score;
    expect(resolved).toBeGreaterThan(0);
    expect(resolved).toBeLessThan(live);
    // Two decimals, not five: points are rounded for storage, so the ratio carries that rounding.
    expect(resolved / live).toBeCloseTo(SOURCE_RESOLVED_FACTOR, 2);
  });

  it("adding a resolved signal to a live one still never lowers the total", () => {
    const live = scoreSignals({ signals: [signal()], evaluatedAt: AT }).score;
    const plusResolved = scoreSignals({
      signals: [signal(), signal({ dedupeKey: "old", sourceResolved: true })],
      evaluatedAt: AT,
    }).score;
    expect(plusResolved).toBeGreaterThanOrEqual(live);
  });
});

describe("freshness", () => {
  it("halves at the half-life and floors rather than reaching zero", () => {
    expect(freshnessFactor("2026-07-07T00:00:00.000Z", AT)).toBeCloseTo(0.5, 5);
    expect(freshnessFactor("2000-01-01T00:00:00.000Z", AT)).toBe(FRESHNESS_FLOOR);
  });

  it("treats a future publication date as fresh rather than as better than fresh", () => {
    expect(freshnessFactor("2027-01-01T00:00:00.000Z", AT)).toBe(1);
  });

  it("treats an unparseable date as maximally aged rather than throwing", () => {
    expect(freshnessFactor("whenever", AT)).toBe(FRESHNESS_FLOOR);
    expect(() =>
      scoreSignals({ signals: [signal({ publishedAt: "x" })], evaluatedAt: AT }),
    ).not.toThrow();
  });
});

describe("honest incompleteness", () => {
  it("reports the catalog components as UNAVAILABLE, never as zero", () => {
    const result = scoreSignals({ signals: [signal()], evaluatedAt: AT });
    const dormant = result.components.filter((c) => !c.available);
    expect(dormant.map((c) => c.name)).toEqual(["daysOnHand", "soleSource"]);
    for (const c of dormant) {
      expect(c.points).toBe(0);
      // The reason names WHY it could not be computed for these items, not a programme milestone:
      // once the catalog has landed, "no stock count" and "no supplier links" are still the two
      // real answers, and the string a console prints has to stay true after ticket 16.
      expect(c.unavailableReason).toMatch(/no (days-on-hand figure|supplier links)/);
    }
    // 65 of 100 is what can be earned today, and the result says so rather than implying 100.
    expect(result.reachableMax).toBe(COMPONENT_BUDGET.signalExposure);
  });

  it("activates them once catalog data is supplied", () => {
    const result = scoreSignals({
      signals: [signal()],
      catalog: { daysOnHand: 3, supplierSiteCount: 1 },
      evaluatedAt: AT,
    });
    expect(result.components.every((c) => c.available)).toBe(true);
    expect(result.reachableMax).toBe(100);
    // Three days of stock from a single supplier site is full exposure on both components.
    expect(points(result).daysOnHand).toBe(COMPONENT_BUDGET.daysOnHand);
    expect(points(result).soleSource).toBe(COMPONENT_BUDGET.soleSource);
  });

  it("scores plentiful stock across several suppliers as low exposure", () => {
    const result = scoreSignals({
      signals: [signal()],
      catalog: { daysOnHand: 120, supplierSiteCount: 4 },
      evaluatedAt: AT,
    });
    expect(points(result).daysOnHand).toBe(0);
    expect(points(result).soleSource).toBeLessThan(COMPONENT_BUDGET.soleSource / 4);
  });
});

describe("the audit capture", () => {
  it("records identifiers and weights, and no raw provider payload", () => {
    const result = scoreSignals({ signals: [signal({ dedupeKey: "org:src:1" })], evaluatedAt: AT });
    expect(result.audit).toEqual({
      scorerVersion: SCORER_VERSION,
      evaluatedAt: AT,
      signalKeys: ["org:src:1"],
      domainRanking: [{ riskDomain: "shortage", strength: expect.any(Number) }],
    });
    expect(JSON.stringify(result.audit)).not.toMatch(/raw|payload|openfda\?/i);
  });

  it("pins the scorer version into the result", () => {
    expect(scoreSignals({ signals: [], evaluatedAt: AT }).scorerVersion).toBe(SCORER_VERSION);
  });
});

describe("bands and the persisted shape", () => {
  it("reads the band off the FRACTION of what the score could reach", () => {
    expect(bandFor(0, 100)).toBe("low");
    expect(bandFor(BAND_THRESHOLDS.moderate * 100, 100)).toBe("moderate");
    expect(bandFor(BAND_THRESHOLDS.high * 100, 100)).toBe("high");
    expect(bandFor(BAND_THRESHOLDS.critical * 100, 100)).toBe("critical");
    expect(bandFor(100, 100)).toBe("critical");
  });

  it("bands against what is REACHABLE, so critical is not unreachable while components are dormant", () => {
    // 43.33 of a 65-point ceiling is two thirds of everything that can be earned today. On an
    // absolute 0-100 ladder it would read `high` at best and `critical` would be impossible —
    // a ranked queue on which nothing can ever be critical is not a ranked queue.
    expect(bandFor(43.33, 65)).toBe("critical");
    expect(bandFor(43.33, 100)).toBe("high");
  });

  it("bands a score with no computable basis as low, rather than dividing by zero", () => {
    expect(bandFor(0, 0)).toBe("low");
    expect(bandFor(Number.NaN, 65)).toBe("low");
  });

  it("keeps availability in what a snapshot row stores, so a zero is never mistaken for a gap", () => {
    const result = scoreSignals({ signals: [signal()], evaluatedAt: AT });
    const record = componentsToRecord(result);
    expect(Object.keys(record)).toEqual(["signalExposure", "daysOnHand", "soleSource"]);
    expect(record.signalExposure).toMatchObject({ available: true, max: 65 });
    // A bare `0` here would be indistinguishable from "this facility has plenty of stock".
    expect(record.daysOnHand).toMatchObject({
      points: 0,
      max: 20,
      available: false,
      unavailableReason: expect.stringContaining("no days-on-hand figure"),
    });
  });

  it("rounds to two decimals, so a numeric(6,2) column round-trips exactly", () => {
    const result = scoreSignals({ signals: [signal({ severityScore: 0.3333 })], evaluatedAt: AT });
    expect(result.score).toBe(Number(result.score.toFixed(2)));
  });

  it("ranks a single maximal signal above a weak one once both are banded", () => {
    const strong = scoreSignals({
      signals: [signal({ severityScore: 1, confidence: 1 })],
      evaluatedAt: AT,
    });
    const weak = scoreSignals({
      signals: [signal({ severityScore: 0.1, confidence: 0.3 })],
      evaluatedAt: AT,
    });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(SCORE_BANDS.indexOf(strong.band)).toBeGreaterThan(SCORE_BANDS.indexOf(weak.band));
  });

  it("scores nothing as zero, in the lowest band", () => {
    const empty = scoreSignals({ signals: [], evaluatedAt: AT });
    expect(empty.score).toBe(0);
    expect(empty.band).toBe("low");
  });
});

describe("a domain the weight table does not list", () => {
  it("still contributes, strictly less than the rank above it and strictly more than nothing", () => {
    // The contract has two risk domains today, but `riskDomain` is a string on the way in. A third
    // one weighted at zero would break the property the ranking is built on — each further matched
    // domain is worth less, and worth something.
    const two = scoreSignals({
      signals: [
        signal({ dedupeKey: "a", riskDomain: "shortage" }),
        signal({ dedupeKey: "b", riskDomain: "recall" }),
      ],
      evaluatedAt: AT,
    });
    const three = scoreSignals({
      signals: [
        signal({ dedupeKey: "a", riskDomain: "shortage" }),
        signal({ dedupeKey: "b", riskDomain: "recall" }),
        signal({ dedupeKey: "c", riskDomain: "contamination" }),
      ],
      evaluatedAt: AT,
    });
    const exposure = (result: typeof two) =>
      result.components.find((component) => component.name === "signalExposure")?.points ?? 0;
    expect(three.audit.domainRanking).toHaveLength(3);
    // Every domain is represented, the third one counts, and the component stays inside its budget.
    expect(exposure(three)).toBeLessThanOrEqual(COMPONENT_BUDGET.signalExposure);
    expect(exposure(three)).toBeGreaterThan(0);
    expect(exposure(two)).toBeGreaterThan(0);
  });

  it("weights each further rank at half the one before it, never at zero", () => {
    expect(domainRankWeight(0)).toBe(1);
    expect(domainRankWeight(1)).toBe(0.5);
    expect(domainRankWeight(2)).toBe(0.25);
    expect(domainRankWeight(5)).toBeGreaterThan(0);
  });
});

describe("catalog completion (ticket 16)", () => {
  const CASES: { name: string; daysOnHand?: number; supplierSiteCount?: number }[] = [
    { name: "well stocked, many suppliers", daysOnHand: 120, supplierSiteCount: 6 },
    { name: "well stocked, sole source", daysOnHand: 120, supplierSiteCount: 1 },
    { name: "nearly out, many suppliers", daysOnHand: 1, supplierSiteCount: 6 },
    { name: "nearly out, sole source", daysOnHand: 0, supplierSiteCount: 1 },
    { name: "stock known, suppliers not", daysOnHand: 30 },
    { name: "suppliers known, stock not", supplierSiteCount: 2 },
  ];

  it.each(CASES)(
    "rescoring after a catalog import never LOWERS the total ($name)",
    ({ daysOnHand, supplierSiteCount }) => {
      // The guarantee the ticket asks for, and the reason it holds: an unavailable component
      // contributes 0 points, and switching it on can only add. A pharmacist who watched a signal
      // sit at 41 must never find it at 33 because the facility uploaded its catalog — that reads
      // as the risk receding when all that changed is that the system learned more.
      for (const severityScore of [0.1, 0.5, 0.95]) {
        for (const sourceResolved of [false, true]) {
          const s = signal({ severityScore, sourceResolved });
          const before = scoreSignals({ signals: [s], evaluatedAt: AT });
          const after = scoreSignals({
            signals: [s],
            catalog: { daysOnHand, supplierSiteCount },
            evaluatedAt: AT,
          });
          expect(after.score).toBeGreaterThanOrEqual(before.score);
        }
      }
    },
  );

  it("marks the two catalog components available once the data lands", () => {
    const result = scoreSignals({
      signals: [signal()],
      catalog: { daysOnHand: 5, supplierSiteCount: 1 },
      evaluatedAt: AT,
    });
    const byName = Object.fromEntries(result.components.map((c) => [c.name, c]));
    expect(byName.daysOnHand?.available).toBe(true);
    expect(byName.soleSource?.available).toBe(true);
    // With every component computable, the whole budget is reachable — a score is now comparable
    // against the full scale rather than against a partial one.
    expect(result.reachableMax).toBe(
      Object.values(COMPONENT_BUDGET).reduce((sum, max) => sum + max, 0),
    );
  });

  it("keeps a component UNAVAILABLE rather than zero when the catalog cannot answer", () => {
    // "This facility has no supplier data" and "this item has no supplier" are different facts.
    const result = scoreSignals({
      signals: [signal()],
      catalog: { daysOnHand: 5 },
      evaluatedAt: AT,
    });
    const byName = Object.fromEntries(result.components.map((c) => [c.name, c]));
    expect(byName.soleSource?.available).toBe(false);
    expect(byName.soleSource?.points).toBe(0);
    expect(byName.soleSource?.unavailableReason).toBeDefined();
  });
});
