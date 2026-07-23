import { z } from "zod";
import { Severity } from "@stopgap/core";

/**
 * Structured outputs for the Phase 2 judgment agents (PROJECT_PLAN §8: "schema-validated
 * outputs everywhere"). `confidence` drives routing — everything still passes through the
 * mandatory HITL protocol-approval gate, but low confidence forces the exception path
 * instead of a shaky auto-drafted protocol (PROJECT_PLAN §8: under-escalation target ≈ 0).
 */

export const ImpactAssessment = z.object({
  severity: Severity,
  /** Estimated formulary items affected by this shortage. */
  affectedFormularyItems: z.number().int().min(0),
  /** One or two sentences explaining the severity call. */
  rationale: z.string().min(1),
  /** Model's self-reported confidence in this assessment, 0 (guessing) to 1 (certain). */
  confidence: z.number().min(0).max(1),
});
export type ImpactAssessment = z.infer<typeof ImpactAssessment>;

export const AlternativesResearch = z.object({
  /** Candidate substitute drugs/protocols. Empty when no therapeutic equivalent exists. */
  alternatives: z.array(z.string()),
  /** Draft substitution protocol text for pharmacist review. Empty if no alternatives. */
  draft: z.string(),
  /** Model's self-reported confidence in the alternatives/draft, 0 to 1. */
  confidence: z.number().min(0).max(1),
});
export type AlternativesResearch = z.infer<typeof AlternativesResearch>;

/** Below this, alternatives research is treated as "no equivalent" and routed to exception. */
export const ALTERNATIVES_CONFIDENCE_THRESHOLD = 0.5;
