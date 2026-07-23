import { describe, expect, it } from "vitest";
import { AlternativesResearch } from "./schemas.js";

describe("AlternativesResearch", () => {
  it("drops blank alternatives so a whitespace entry cannot fake a substitute", () => {
    const parsed = AlternativesResearch.parse({
      alternatives: [" ", "", "  Argatroban  "],
      draft: "Switch to argatroban per protocol.",
      confidence: 0.8,
    });
    expect(parsed.alternatives).toEqual(["Argatroban"]);
  });

  it("clears the draft when every alternative was blank", () => {
    const parsed = AlternativesResearch.parse({
      alternatives: [" "],
      draft: "Consult the physician.",
      confidence: 0.7,
    });
    expect(parsed.alternatives).toEqual([]);
    expect(parsed.draft).toBe("");
  });

  it("normalizes a percentage confidence into 0-1", () => {
    const parsed = AlternativesResearch.parse({ alternatives: [], draft: "", confidence: 90 });
    expect(parsed.confidence).toBeCloseTo(0.9);
  });
});
