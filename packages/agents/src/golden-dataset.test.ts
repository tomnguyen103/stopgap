import { describe, expect, it } from "vitest";
import { GOLDEN_DATASET, evalSubset, severityMeetsFloor, severityWithinCeiling } from "./golden-dataset.js";

/**
 * Structural checks on the corpus itself (no model calls — this runs in the hard gate).
 * The live scoring lives in `golden-dataset.eval.ts`.
 */
describe("golden dataset", () => {
  it("meets the plan's 60-100 case target", () => {
    expect(GOLDEN_DATASET.length).toBeGreaterThanOrEqual(60);
    expect(GOLDEN_DATASET.length).toBeLessThanOrEqual(100);
  });

  it("has unique ids — a duplicate would silently overwrite a case in reporting", () => {
    const ids = GOLDEN_DATASET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every case a usable record and a coherent severity window", () => {
    for (const goldenCase of GOLDEN_DATASET) {
      expect(goldenCase.record.genericName.length).toBeGreaterThan(0);
      expect(goldenCase.record.ndcs.length).toBeGreaterThan(0);
      const { severityAtLeast, severityAtMost } = goldenCase.expected;
      if (severityAtMost) {
        expect(severityMeetsFloor(severityAtMost, severityAtLeast)).toBe(true);
      }
    }
  });

  it("covers both the no-alternative and resolved-shortage failure modes", () => {
    expect(GOLDEN_DATASET.some((c) => !c.expected.hasAlternative)).toBe(true);
    expect(GOLDEN_DATASET.some((c) => c.record.status === "resolved")).toBe(true);
    expect(GOLDEN_DATASET.some((c) => c.expected.severityAtMost)).toBe(true);
  });

  it("selects a stable, spread-out subset for routine eval runs", () => {
    const first = evalSubset();
    expect(first).toHaveLength(12);
    expect(evalSubset().map((c) => c.id)).toEqual(first.map((c) => c.id));
    expect(new Set(first.map((c) => c.id)).size).toBe(first.length);
    // The stride must reach the tail of the corpus, not just the first cases.
    const lastIndex = GOLDEN_DATASET.findIndex((c) => c.id === first[first.length - 1]?.id);
    expect(lastIndex).toBeGreaterThan(GOLDEN_DATASET.length / 2);
  });

  it("returns the whole corpus when the requested subset is larger than it", () => {
    expect(evalSubset(GOLDEN_DATASET, GOLDEN_DATASET.length + 10)).toHaveLength(GOLDEN_DATASET.length);
  });
});

describe("severity comparators", () => {
  it("ranks the severity ladder", () => {
    expect(severityMeetsFloor("critical", "high")).toBe(true);
    expect(severityMeetsFloor("low", "high")).toBe(false);
    expect(severityWithinCeiling("low", "moderate")).toBe(true);
    expect(severityWithinCeiling("critical", "moderate")).toBe(false);
  });
});
