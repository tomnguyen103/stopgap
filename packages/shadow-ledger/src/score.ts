import type { OrdinalScale } from "./scale.js";

/**
 * Agreement scoring: how close was the agent's judgement to the human baseline?
 *
 * Two axes, because they are the two a human can label cheaply and honestly:
 * - an ordinal **level** (severity, risk, priority);
 * - a boolean **outcome** (was there an answer at all: a substitute, a match, a fix).
 *
 * The score is deliberately coarse. Scoring "did it pick the same specific answer" needs a
 * label nobody actually produces at scale, and inventing one makes the number look precise
 * while measuring nothing.
 */

export interface Judgement<Level extends string> {
  level: Level;
  /** Did the agent produce an answer at all? */
  hasOutcome: boolean;
}

export interface Baseline<Level extends string> {
  level: Level;
  /** Per the human label, does an answer exist? */
  hasOutcome: boolean;
}

export interface AgreementScore {
  /** 0-1; 1 means the agent matched the human on both axes. */
  agreement: number;
  levelAgreed: boolean;
  /**
   * True when the agent called the case LOWER on the scale than the human did. Tracked apart
   * from plain disagreement because the two directions are not symmetric: over-calling costs
   * review time, under-calling is the one that lets something through.
   */
  levelUnderCalled: boolean;
  outcomeAgreed: boolean;
}

export function scoreAgreement<Level extends string>(
  scale: OrdinalScale<Level>,
  proposal: Judgement<Level>,
  baseline: Baseline<Level>,
): AgreementScore {
  const levelAgreed = proposal.level === baseline.level;
  const levelUnderCalled = scale.rank(proposal.level) < scale.rank(baseline.level);
  const outcomeAgreed = proposal.hasOutcome === baseline.hasOutcome;
  return {
    agreement: (Number(levelAgreed) + Number(outcomeAgreed)) / 2,
    levelAgreed,
    levelUnderCalled,
    outcomeAgreed,
  };
}

/** Aggregates over one cohort of scored runs — the input to the promotion gates. */
export interface CohortStats {
  runs: number;
  meanAgreement: number;
  levelAgreementRate: number;
  underCallRate: number;
}

/**
 * Summarize scores for one cohort. An empty cohort is not an error and not a zero-agreement
 * cohort: it is a cohort with no evidence, and the gates below treat "no evidence" as
 * "not promoted" via `runs`, which is the honest reading.
 */
export function aggregate(scores: readonly AgreementScore[]): CohortStats {
  const runs = scores.length;
  if (runs === 0) {
    return { runs: 0, meanAgreement: 0, levelAgreementRate: 0, underCallRate: 0 };
  }
  const sum = (pick: (s: AgreementScore) => number) =>
    scores.reduce((acc, s) => acc + pick(s), 0);
  return {
    runs,
    meanAgreement: sum((s) => s.agreement) / runs,
    levelAgreementRate: sum((s) => Number(s.levelAgreed)) / runs,
    underCallRate: sum((s) => Number(s.levelUnderCalled)) / runs,
  };
}
