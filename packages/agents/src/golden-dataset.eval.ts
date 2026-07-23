import { describe, expect, it } from "vitest";
import { assessImpact } from "./impact.js";
import { researchAlternatives } from "./alternatives.js";
import { GOLDEN_DATASET, evalSubset, severityMeetsFloor, severityWithinCeiling } from "./golden-dataset.js";

/**
 * `pnpm eval` runs a deterministic stride through the corpus; `pnpm eval:full` (EVAL_FULL=1)
 * runs all ~85 cases. See `evalSubset` for why the default is a subset.
 */
const CASES = process.env.EVAL_FULL === "1" ? GOLDEN_DATASET : evalSubset();

/**
 * Eval gate (PROJECT_PLAN §8): runs the golden dataset against the live agents on Ollama
 * (temperature 0, pinned local model — see @stopgap/core/env OLLAMA_MODEL default) as part
 * of the local gate/CI, zero API cost. Loose bounds (severity floor, alternative-existence)
 * rather than exact matches — small local models won't reproduce a human labeler exactly,
 * but should land in the right neighborhood every time.
 *
 * Best-of-3, majority vote per case: a small local model's inference isn't perfectly
 * deterministic even at temperature 0 (observed live — the same golden case occasionally
 * flips its alternatives-exist call between identical runs). A regression gate that fails
 * the whole build on that noise is worse than useless: it teaches everyone to ignore red.
 * Majority vote across a few samples absorbs the noise while still catching a real
 * regression (which fails consistently, not ~1 run in 3).
 */
async function majorityVote(trials: number, attempt: () => Promise<boolean>): Promise<boolean> {
  let passes = 0;
  for (let i = 0; i < trials; i++) {
    if (await attempt()) passes += 1;
  }
  return passes > trials / 2;
}

describe(`golden dataset eval (live Ollama, ${CASES.length}/${GOLDEN_DATASET.length} cases)`, () => {
  for (const goldenCase of CASES) {
    it(`${goldenCase.id}: severity >= ${goldenCase.expected.severityAtLeast}, alternative expected = ${goldenCase.expected.hasAlternative}`, async () => {
      const severityOk = await majorityVote(3, async () => {
        const impact = await assessImpact(goldenCase.record);
        const floorOk = severityMeetsFloor(impact.severity, goldenCase.expected.severityAtLeast);
        const ceilingOk = goldenCase.expected.severityAtMost
          ? severityWithinCeiling(impact.severity, goldenCase.expected.severityAtMost)
          : true;
        return floorOk && ceilingOk;
      });
      expect(severityOk).toBe(true);

      const alternativesOk = await majorityVote(3, async () => {
        const research = await researchAlternatives(goldenCase.record);
        return (research.alternatives.length > 0) === goldenCase.expected.hasAlternative;
      });
      expect(alternativesOk).toBe(true);
    }, 60_000);
  }
});
