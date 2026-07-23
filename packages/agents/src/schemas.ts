import { z } from "zod";
import { Severity } from "@stopgap/core";

/**
 * Structured outputs for the Phase 2 judgment agents (PROJECT_PLAN §8: "schema-validated
 * outputs everywhere"). `confidence` drives routing — everything still passes through the
 * mandatory HITL protocol-approval gate, but low confidence forces the exception path
 * instead of a shaky auto-drafted protocol (PROJECT_PLAN §8: under-escalation target ≈ 0).
 */

/**
 * Confidence, normalized to 0-1. Small local models sometimes ignore the "0 to 1" prompt
 * instruction and report a 0-100 percentage instead (observed live: `confidence: 90`) — at
 * temperature 0 that's a deterministic, permanently-repeating schema failure, not a
 * transient one, so normalize rather than reject. Values already in [0,1] pass through.
 */
const confidenceScore = z.preprocess(
  (v) => (typeof v === "number" && v > 1 ? v / 100 : v),
  z.number().min(0).max(1),
);

export const ImpactAssessment = z.object({
  severity: Severity,
  /** Estimated formulary items affected by this shortage. */
  affectedFormularyItems: z.number().int().min(0),
  /** One or two sentences explaining the severity call. */
  rationale: z.string().min(1),
  /** Model's self-reported confidence in this assessment, 0 (guessing) to 1 (certain). */
  confidence: confidenceScore,
});
export type ImpactAssessment = z.infer<typeof ImpactAssessment>;

export const AlternativesResearch = z
  .object({
    /**
     * Candidate substitute drugs/protocols. Empty when no therapeutic equivalent exists.
     * Blank/whitespace entries are dropped: `[" "]` would otherwise read as "an alternative
     * exists" and bypass the no-equivalent exception path with nothing to substitute.
     */
    alternatives: z
      .array(z.string())
      .transform((list) => list.map((item) => item.trim()).filter((item) => item.length > 0)),
    /** Draft substitution protocol text for pharmacist review. Empty if no alternatives. */
    draft: z.string(),
    /** Model's self-reported confidence in the alternatives/draft, 0 to 1. */
    confidence: confidenceScore,
  })
  // A non-empty draft with zero alternatives is a contradictory protocol (e.g. the model
  // writes advisory text like "consult the physician" instead of a real substitution). Clear
  // it rather than reject: this runs at temperature 0, so a rejecting `.refine()` here would
  // fail the same way on every retry — a permanent failure for that input, not a transient
  // one. Normalizing keeps the invariant (empty alternatives => empty draft) without that.
  .transform((v) => (v.alternatives.length === 0 && v.draft.trim().length > 0 ? { ...v, draft: "" } : v));
export type AlternativesResearch = z.infer<typeof AlternativesResearch>;

/**
 * Below this, either agent's output is treated as too uncertain to act on and the case
 * routes to the exception queue instead — applies to both `ImpactAssessment.confidence`
 * (a shaky severity call) and `AlternativesResearch.confidence` (a shaky substitution).
 */
export const CONFIDENCE_THRESHOLD = 0.5;
