import { describe, expect, it } from "vitest";
import { DEFAULT_GATES, evaluatePromotion } from "./promotion.js";
import { createScale } from "./scale.js";
import { aggregate, scoreAgreement } from "./score.js";
import { ShadowLedger } from "./ledger.js";

const severity = createScale(["none", "low", "moderate", "high", "critical"] as const);

describe("createScale", () => {
  it("ranks levels in the order given", () => {
    expect(severity.rank("none")).toBeLessThan(severity.rank("critical"));
  });

  it("rejects a duplicate level rather than making rank() ambiguous", () => {
    expect(() => createScale(["low", "low"])).toThrow(/duplicate level/);
  });

  it("rejects an unknown level instead of scoring against a guess", () => {
    // @ts-expect-error — the runtime guard exists for callers without types.
    expect(() => severity.rank("catastrophic")).toThrow(/not in scale/);
  });
});

describe("scoreAgreement", () => {
  it("scores a full match as 1", () => {
    expect(
      scoreAgreement(
        severity,
        { level: "high", hasOutcome: true },
        { level: "high", hasOutcome: true },
      ),
    ).toEqual({ agreement: 1, levelAgreed: true, levelUnderCalled: false, outcomeAgreed: true });
  });

  it("splits the score when only one axis matches", () => {
    const score = scoreAgreement(
      severity,
      { level: "low", hasOutcome: true },
      { level: "high", hasOutcome: true },
    );
    expect(score.agreement).toBe(0.5);
    expect(score.levelUnderCalled).toBe(true);
  });

  it("flags over-calling as disagreement but not as an under-call", () => {
    const score = scoreAgreement(
      severity,
      { level: "critical", hasOutcome: true },
      { level: "low", hasOutcome: true },
    );
    expect(score.levelAgreed).toBe(false);
    expect(score.levelUnderCalled).toBe(false);
  });
});

describe("aggregate", () => {
  it("reports an empty cohort as zero runs rather than zero agreement", () => {
    expect(aggregate([])).toEqual({
      runs: 0,
      meanAgreement: 0,
      levelAgreementRate: 0,
      underCallRate: 0,
    });
  });

  it("averages agreement and rates over the cohort", () => {
    const scores = [
      scoreAgreement(severity, { level: "high", hasOutcome: true }, { level: "high", hasOutcome: true }),
      scoreAgreement(severity, { level: "low", hasOutcome: true }, { level: "high", hasOutcome: true }),
    ];
    expect(aggregate(scores)).toEqual({
      runs: 2,
      meanAgreement: 0.75,
      levelAgreementRate: 0.5,
      underCallRate: 0.5,
    });
  });
});

describe("evaluatePromotion", () => {
  const perfect = { runs: 100, meanAgreement: 1, levelAgreementRate: 1, underCallRate: 0 };

  it("holds a cohort at shadow until it has enough evidence", () => {
    const decision = evaluatePromotion({ ...perfect, runs: 5 });
    expect(decision.stage).toBe("shadow");
    expect(decision.blockedBy[0]).toMatch(/needs 20 scored runs/);
  });

  it("promotes a well-evidenced cohort all the way", () => {
    expect(evaluatePromotion(perfect)).toEqual({ stage: "autonomous", blockedBy: [] });
  });

  it("holds at suggest when under-calling exceeds the autonomous ceiling", () => {
    const decision = evaluatePromotion({ ...perfect, underCallRate: 0.03 });
    expect(decision.stage).toBe("suggest");
    expect(decision.blockedBy.join(" ")).toMatch(/under-call rate/);
  });

  it("accepts custom gates", () => {
    const gates = {
      ...DEFAULT_GATES,
      suggest: { ...DEFAULT_GATES.suggest, minRuns: 2 },
      autonomous: { ...DEFAULT_GATES.autonomous, minRuns: 2 },
    };
    expect(evaluatePromotion({ ...perfect, runs: 2 }, gates).stage).toBe("autonomous");
  });
});

describe("ShadowLedger", () => {
  it("scores and stores runs, then aggregates them per cohort", async () => {
    const ledger = new ShadowLedger(severity);
    await ledger.record({
      inputId: "case-1",
      cohort: "injectable",
      proposal: { level: "high", hasOutcome: true },
      baseline: { level: "high", hasOutcome: true },
    });
    await ledger.record({
      inputId: "case-2",
      cohort: "injectable",
      proposal: { level: "low", hasOutcome: false },
      baseline: { level: "critical", hasOutcome: true },
    });
    await ledger.record({
      inputId: "case-3",
      cohort: "oncology",
      proposal: { level: "critical", hasOutcome: true },
      baseline: { level: "critical", hasOutcome: true },
    });

    const injectable = await ledger.statsFor("injectable");
    expect(injectable).toEqual({
      runs: 2,
      meanAgreement: 0.5,
      levelAgreementRate: 0.5,
      underCallRate: 0.5,
    });

    const byCohort = await ledger.statsByCohort();
    expect([...byCohort.keys()].sort()).toEqual(["injectable", "oncology"]);
    expect(byCohort.get("oncology")?.meanAgreement).toBe(1);
  });

  it("reports an unknown cohort as having no evidence, not as failing", async () => {
    const ledger = new ShadowLedger(severity);
    expect(await ledger.statsFor("nothing-here")).toMatchObject({ runs: 0 });
    expect(evaluatePromotion(await ledger.statsFor("nothing-here")).stage).toBe("shadow");
  });
});
