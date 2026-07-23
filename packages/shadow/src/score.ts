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

export interface ShadowProposal {
  severity: string;
  alternatives: string[];
}

export interface ShadowBaseline {
  severity: string;
  /** Whether a real therapeutic alternative exists, per the human label. */
  hasAlternative: boolean;
}

export interface AgreementScore {
  /** 0-1; 1 means the agent matched the human on both axes. */
  agreement: number;
  severityAgreed: boolean;
  alternativeExistenceAgreed: boolean;
}

export function scoreAgreement(proposal: ShadowProposal, baseline: ShadowBaseline): AgreementScore {
  const severityAgreed = proposal.severity === baseline.severity;
  const alternativeExistenceAgreed = proposal.alternatives.length > 0 === baseline.hasAlternative;
  return {
    agreement: (Number(severityAgreed) + Number(alternativeExistenceAgreed)) / 2,
    severityAgreed,
    alternativeExistenceAgreed,
  };
}
