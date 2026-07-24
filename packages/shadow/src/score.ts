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

const SEVERITY_RANK: Severity[] = ["none", "low", "moderate", "high", "critical"];

export function scoreAgreement(proposal: ShadowProposal, baseline: ShadowBaseline): AgreementScore {
  const severityAgreed = proposal.severity === baseline.severity;
  const severityUnderCalled =
    SEVERITY_RANK.indexOf(proposal.severity) < SEVERITY_RANK.indexOf(baseline.severity);
  const alternativeExistenceAgreed = proposal.alternatives.length > 0 === baseline.hasAlternative;
  return {
    agreement: (Number(severityAgreed) + Number(alternativeExistenceAgreed)) / 2,
    severityAgreed,
    severityUnderCalled,
    alternativeExistenceAgreed,
  };
}
