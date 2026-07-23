import { describe, expect, it } from "vitest";
import { assessImpact } from "./impact.js";
import { researchAlternatives } from "./alternatives.js";
import { GOLDEN_DATASET, severityMeetsFloor } from "./golden-dataset.js";

/**
 * Eval gate (PROJECT_PLAN §8): runs the golden dataset against the live agents on Ollama
 * (temperature 0, pinned local model — see @stopgap/core/env OLLAMA_MODEL default) as part
 * of the local gate/CI, zero API cost. Loose bounds (severity floor, alternative-existence)
 * rather than exact matches — small local models won't reproduce a human labeler exactly,
 * but should land in the right neighborhood every time.
 */
describe("golden dataset eval (live Ollama)", () => {
  for (const goldenCase of GOLDEN_DATASET) {
    it(`${goldenCase.id}: severity >= ${goldenCase.expected.severityAtLeast}, alternative expected = ${goldenCase.expected.hasAlternative}`, async () => {
      const impact = await assessImpact(goldenCase.record);
      expect(severityMeetsFloor(impact.severity, goldenCase.expected.severityAtLeast)).toBe(true);

      const research = await researchAlternatives(goldenCase.record);
      expect(research.alternatives.length > 0).toBe(goldenCase.expected.hasAlternative);
    }, 30_000);
  }
});
