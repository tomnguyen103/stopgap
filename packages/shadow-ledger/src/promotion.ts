import type { CohortStats } from "./score.js";

/**
 * Promotion gates: how much autonomy a cohort has EARNED from its measured agreement.
 *
 * The point of shadow mode is that autonomy is granted by evidence, not by a calendar date
 * or a demo that went well. A cohort must have been scored against the human baseline enough
 * times, and have agreed often enough, before its output is shown as a suggestion — and again
 * at a higher bar before it is allowed to act first and have a human check afterwards.
 *
 * Gates are per cohort because agreement on one class of input says nothing about agreement
 * on another.
 */

export type Stage = "shadow" | "suggest" | "autonomous";

export interface Thresholds {
  minRuns: number;
  minMeanAgreement: number;
  minLevelAgreementRate: number;
  /**
   * Ceiling on the share of runs where the agent called the case LOWER than the human. A
   * plain agreement rate treats both directions of a miss as equivalent; this one does not.
   */
  maxUnderCallRate: number;
}

export type Gates = Record<Exclude<Stage, "shadow">, Thresholds>;

/**
 * Defaults tuned for "a human reviews everything at first". They are a starting point, not a
 * recommendation for your domain — the level bar is stricter than the overall agreement bar
 * because under-calling is usually the failure that matters.
 */
export const DEFAULT_GATES: Gates = {
  suggest: {
    minRuns: 20,
    minMeanAgreement: 0.8,
    minLevelAgreementRate: 0.85,
    maxUnderCallRate: 0.05,
  },
  autonomous: {
    minRuns: 50,
    minMeanAgreement: 0.9,
    minLevelAgreementRate: 0.95,
    maxUnderCallRate: 0.01,
  },
};

export interface PromotionDecision {
  stage: Stage;
  /**
   * Why the cohort did not advance further, in words meant for a dashboard. A gate that only
   * says "no" teaches nobody what would change the answer.
   */
  blockedBy: string[];
}

function unmet(stats: CohortStats, t: Thresholds): string[] {
  const reasons: string[] = [];
  if (stats.runs < t.minRuns) reasons.push(`needs ${t.minRuns} scored runs (has ${stats.runs})`);
  if (stats.meanAgreement < t.minMeanAgreement) {
    reasons.push(
      `needs mean agreement ${t.minMeanAgreement} (has ${stats.meanAgreement.toFixed(2)})`,
    );
  }
  if (stats.levelAgreementRate < t.minLevelAgreementRate) {
    reasons.push(
      `needs level agreement ${t.minLevelAgreementRate} (has ${stats.levelAgreementRate.toFixed(2)})`,
    );
  }
  if (stats.underCallRate > t.maxUnderCallRate) {
    reasons.push(
      `needs under-call rate at or below ${t.maxUnderCallRate} (has ${stats.underCallRate.toFixed(2)})`,
    );
  }
  return reasons;
}

/** The stage a cohort has earned from its aggregates. */
export function evaluatePromotion(stats: CohortStats, gates: Gates = DEFAULT_GATES): PromotionDecision {
  const suggestBlockers = unmet(stats, gates.suggest);
  if (suggestBlockers.length > 0) return { stage: "shadow", blockedBy: suggestBlockers };
  const autonomousBlockers = unmet(stats, gates.autonomous);
  if (autonomousBlockers.length > 0) return { stage: "suggest", blockedBy: autonomousBlockers };
  return { stage: "autonomous", blockedBy: [] };
}
