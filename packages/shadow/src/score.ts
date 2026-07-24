/**
 * Shadow-mode agreement scoring (PROJECT_PLAN §3A). Deterministic and model-free: given what
 * the agent proposed and what the human baseline says, how close were they?
 *
 * The score is deliberately coarse. The replay corpus labels a severity rung and whether a
 * therapeutic alternative exists — it does not label which specific substitute a pharmacist
 * would have picked, and inventing that label would make the agreement number look precise
 * while measuring nothing. So agreement is the mean of two things a human actually labeled:
 * did the severity call match, and did the agent agree that a substitute exists at all.
 */

import type { Severity } from "@stopgap/core";
import { createScale, scoreAgreement as scoreOrdinal, type AgreementScore as LibScore } from "shadow-ledger";

export interface ShadowProposal {
  severity: Severity;
  alternatives: string[];
}

export interface ShadowBaseline {
  severity: Severity;
  /** Whether a real therapeutic alternative exists, per the human label. */
  hasAlternative: boolean;
}

export interface AgreementScore {
  /** 0-1; 1 means the agent matched the human on both axes. */
  agreement: number;
  severityAgreed: boolean;
  /**
   * True when the agent called the shortage LESS severe than the human. The two directions
   * of a severity miss are not equally bad — over-escalation costs pharmacist time,
   * under-escalation is the one PROJECT_PLAN §8 targets at ~0 — so the promotion gates bound
   * this on its own rather than folding it into overall disagreement.
   */
  severityUnderCalled: boolean;
  alternativeExistenceAgreed: boolean;
}

/**
 * The scoring itself now lives in the extracted `shadow-ledger` library (PROJECT_PLAN §12.5);
 * this module is the Stopgap-shaped adapter over it. Keeping the adapter means the domain
 * vocabulary stays domain vocabulary — a pharmacist reads "severity under-called", not
 * "level under-called" — while the mechanism has one implementation and one test suite.
 */
export const SEVERITY_SCALE = createScale<Severity>(["none", "low", "moderate", "high", "critical"]);

export function scoreAgreement(proposal: ShadowProposal, baseline: ShadowBaseline): AgreementScore {
  const score: LibScore = scoreOrdinal(
    SEVERITY_SCALE,
    { level: proposal.severity, hasOutcome: proposal.alternatives.length > 0 },
    { level: baseline.severity, hasOutcome: baseline.hasAlternative },
  );
  return {
    agreement: score.agreement,
    severityAgreed: score.levelAgreed,
    severityUnderCalled: score.levelUnderCalled,
    alternativeExistenceAgreed: score.outcomeAgreed,
  };
}
