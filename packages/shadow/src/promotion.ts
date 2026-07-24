import type { ShadowClassStats } from "@stopgap/db";
import {
  evaluatePromotion as evaluateGates,
  type CohortStats,
  type Gates,
} from "shadow-ledger";

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
  /**
   * Ceiling on the share of runs where the agent called a shortage LESS severe than the
   * human. A plain agreement rate treats the two directions of a miss as equivalent; this one
   * does not, because only one of them sends a critical shortage down the low-priority path.
   */
  maxUnderEscalationRate: number;
}

/**
 * Bars for each promotion step. The severity bar is stricter than the overall agreement bar
 * because under-escalation is the dangerous failure mode (PROJECT_PLAN §8 targets ≈ 0).
 */
export const PROMOTION_GATES: Record<Exclude<PromotionStage, "shadow">, PromotionThresholds> = {
  suggest: {
    minRuns: 20,
    minMeanAgreement: 0.8,
    minSeverityAgreementRate: 0.85,
    maxUnderEscalationRate: 0.05,
  },
  "auto-draft": {
    minRuns: 50,
    minMeanAgreement: 0.9,
    minSeverityAgreementRate: 0.95,
    maxUnderEscalationRate: 0.01,
  },
};

/**
 * The gate arithmetic lives in the extracted `shadow-ledger` library (PROJECT_PLAN §12.5).
 * This module keeps Stopgap's vocabulary — "auto-draft" says what the stage actually buys
 * here, and "under-escalation" is the word a pharmacist uses — and translates.
 */
const LIB_GATES: Gates = {
  suggest: {
    minRuns: PROMOTION_GATES.suggest.minRuns,
    minMeanAgreement: PROMOTION_GATES.suggest.minMeanAgreement,
    minLevelAgreementRate: PROMOTION_GATES.suggest.minSeverityAgreementRate,
    maxUnderCallRate: PROMOTION_GATES.suggest.maxUnderEscalationRate,
  },
  autonomous: {
    minRuns: PROMOTION_GATES["auto-draft"].minRuns,
    minMeanAgreement: PROMOTION_GATES["auto-draft"].minMeanAgreement,
    minLevelAgreementRate: PROMOTION_GATES["auto-draft"].minSeverityAgreementRate,
    maxUnderCallRate: PROMOTION_GATES["auto-draft"].maxUnderEscalationRate,
  },
};

export interface PromotionDecision {
  stage: PromotionStage;
  /** Why the class did not advance further — shown in the dashboard, not just logged. */
  blockedBy: string[];
}

/** The stage a drug class has earned from its shadow-ledger aggregates. */
export function evaluatePromotion(stats: ShadowClassStats): PromotionDecision {
  const cohort: CohortStats = {
    runs: stats.runs,
    meanAgreement: stats.meanAgreement,
    levelAgreementRate: stats.severityAgreementRate,
    underCallRate: stats.underEscalationRate,
  };
  const decision = evaluateGates(cohort, LIB_GATES);
  return {
    stage: decision.stage === "autonomous" ? "auto-draft" : decision.stage,
    // The library says "level"/"under-call"; the dashboard this feeds is read by pharmacists.
    blockedBy: decision.blockedBy.map((reason: string) =>
      reason.replace("level agreement", "severity agreement").replace("under-call rate", "under-escalation rate"),
    ),
  };
}
