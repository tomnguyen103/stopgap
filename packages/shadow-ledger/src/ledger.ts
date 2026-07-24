import type { AgreementScore, Baseline, CohortStats, Judgement } from "./score.js";
import { aggregate, scoreAgreement } from "./score.js";
import type { OrdinalScale } from "./scale.js";

/**
 * The ledger: scored runs, grouped by cohort.
 *
 * Storage is an interface, not an implementation. Any real deployment already has a database
 * and wants these rows in it, next to the records they are about; a library that insisted on
 * its own store would either be ignored or bolted alongside the real one. The in-memory
 * implementation below is for tests and small batch runs.
 */

export interface ShadowRun<Level extends string> {
  /** Identifier of the replayed input, so a run is traceable to what produced it. */
  inputId: string;
  /** The group whose autonomy this run counts toward (drug class, queue, customer tier…). */
  cohort: string;
  proposal: Judgement<Level>;
  baseline: Baseline<Level>;
  score: AgreementScore;
  ranAt: Date;
}

export interface ShadowStore<Level extends string> {
  append(run: ShadowRun<Level>): Promise<void>;
  byCohort(cohort: string): Promise<ShadowRun<Level>[]>;
  cohorts(): Promise<string[]>;
}

export class InMemoryShadowStore<Level extends string> implements ShadowStore<Level> {
  private runs: ShadowRun<Level>[] = [];

  append(run: ShadowRun<Level>): Promise<void> {
    this.runs.push(run);
    return Promise.resolve();
  }

  byCohort(cohort: string): Promise<ShadowRun<Level>[]> {
    return Promise.resolve(this.runs.filter((r) => r.cohort === cohort));
  }

  cohorts(): Promise<string[]> {
    return Promise.resolve([...new Set(this.runs.map((r) => r.cohort))]);
  }
}

export interface RecordRunInput<Level extends string> {
  inputId: string;
  cohort: string;
  proposal: Judgement<Level>;
  baseline: Baseline<Level>;
  ranAt?: Date;
}

/**
 * Score one run and append it. Scoring and storing are one call because a run that is stored
 * unscored, or scored and not stored, is the failure mode that quietly empties a ledger.
 */
export class ShadowLedger<Level extends string> {
  constructor(
    private readonly scale: OrdinalScale<Level>,
    private readonly store: ShadowStore<Level> = new InMemoryShadowStore<Level>(),
  ) {}

  async record(input: RecordRunInput<Level>): Promise<ShadowRun<Level>> {
    const score = scoreAgreement(this.scale, input.proposal, input.baseline);
    const run: ShadowRun<Level> = {
      inputId: input.inputId,
      cohort: input.cohort,
      proposal: input.proposal,
      baseline: input.baseline,
      score,
      ranAt: input.ranAt ?? new Date(),
    };
    await this.store.append(run);
    return run;
  }

  async statsFor(cohort: string): Promise<CohortStats> {
    const runs = await this.store.byCohort(cohort);
    return aggregate(runs.map((r) => r.score));
  }

  async statsByCohort(): Promise<Map<string, CohortStats>> {
    const cohorts = await this.store.cohorts();
    const entries = await Promise.all(
      cohorts.map(async (c) => [c, await this.statsFor(c)] as const),
    );
    return new Map(entries);
  }
}
