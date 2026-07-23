import type { ShadowClassStats } from "@stopgap/db";

/**
 * Per-drug-class promotion gates (PROJECT_PLAN §3A: shadow → suggest → auto-draft).
 *
 * A class earns autonomy by evidence, not by calendar date: the agent must have been scored
 * against the human baseline enough times, and have agreed often enough, before its output is
 * shown to a pharmacist as a suggestion — and again, at a higher bar, before it is allowed to
 * pre-draft a protocol. Gates are per class because agreement on antiemetics says nothing
 * about agreement on chemotherapy.
 *
 * Note what promotion does NOT buy: even at `auto-draft`, every protocol still passes through
 * the mandatory pharmacist approval gate. The stages control how much work the agent does
 * before a human looks, never whether a human looks.
 */

export type PromotionStage = "shadow" | "suggest" | "auto-draft";

export interface PromotionThresholds {
  minRuns: number;
  minMeanAgreement: number;
  minSeverityAgreementRate: number;
}

/**
 * Bars for each promotion step. The severity bar is stricter than the overall agreement bar
 * because under-escalation is the dangerous failure mode (PROJECT_PLAN §8 targets ≈ 0).
 */
export const PROMOTION_GATES: Record<Exclude<PromotionStage, "shadow">, PromotionThresholds> = {
  suggest: { minRuns: 20, minMeanAgreement: 0.8, minSeverityAgreementRate: 0.85 },
  "auto-draft": { minRuns: 50, minMeanAgreement: 0.9, minSeverityAgreementRate: 0.95 },
};

export interface PromotionDecision {
  stage: PromotionStage;
  /** Why the class did not advance further — shown in the dashboard, not just logged. */
  blockedBy: string[];
}

function unmet(stats: ShadowClassStats, thresholds: PromotionThresholds): string[] {
  const reasons: string[] = [];
  if (stats.runs < thresholds.minRuns) {
    reasons.push(`needs ${thresholds.minRuns} scored runs (has ${stats.runs})`);
  }
  if (stats.meanAgreement < thresholds.minMeanAgreement) {
    reasons.push(
      `needs mean agreement ${thresholds.minMeanAgreement} (has ${stats.meanAgreement.toFixed(2)})`,
    );
  }
  if (stats.severityAgreementRate < thresholds.minSeverityAgreementRate) {
    reasons.push(
      `needs severity agreement ${thresholds.minSeverityAgreementRate} (has ${stats.severityAgreementRate.toFixed(2)})`,
    );
  }
  return reasons;
}

/** The stage a drug class has earned from its shadow-ledger aggregates. */
export function evaluatePromotion(stats: ShadowClassStats): PromotionDecision {
  const suggestBlockers = unmet(stats, PROMOTION_GATES.suggest);
  if (suggestBlockers.length > 0) return { stage: "shadow", blockedBy: suggestBlockers };

  const autoDraftBlockers = unmet(stats, PROMOTION_GATES["auto-draft"]);
  if (autoDraftBlockers.length > 0) return { stage: "suggest", blockedBy: autoDraftBlockers };

  return { stage: "auto-draft", blockedBy: [] };
}
