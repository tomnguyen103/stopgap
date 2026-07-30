import type { ShortageRecord } from "@stopgap/core";
import { describe, expect, it } from "vitest";
import { REPLAY_CORPUS, drugClassFor } from "./corpus.js";
import { PROMOTION_GATES, evaluatePromotion } from "./promotion.js";
import { scoreAgreement } from "./score.js";

const stats = (over: Partial<Parameters<typeof evaluatePromotion>[0]> = {}) => ({
  drugClass: "injectable",
  runs: 100,
  meanAgreement: 1,
  severityAgreementRate: 1,
  underEscalationRate: 0,
  meanLatencyMs: 1000,
  totalUsdCost: 0,
  ...over,
});

describe("scoreAgreement", () => {
  it("scores a full match as 1", () => {
    const score = scoreAgreement(
      { severity: "high", alternatives: ["Argatroban"] },
      { severity: "high", hasAlternative: true },
    );
    expect(score).toEqual({
      agreement: 1,
      severityAgreed: true,
      severityUnderCalled: false,
      alternativeExistenceAgreed: true,
    });
  });

  it("scores a total mismatch as 0", () => {
    const score = scoreAgreement(
      { severity: "low", alternatives: [] },
      { severity: "critical", hasAlternative: true },
    );
    expect(score.agreement).toBe(0);
  });

  it("splits the score when only one axis matches", () => {
    const score = scoreAgreement(
      { severity: "high", alternatives: [] },
      { severity: "high", hasAlternative: true },
    );
    expect(score.agreement).toBe(0.5);
    expect(score.severityAgreed).toBe(true);
    expect(score.alternativeExistenceAgreed).toBe(false);
  });

  it("counts a fabricated substitute for a no-equivalent drug as disagreement", () => {
    const score = scoreAgreement(
      { severity: "high", alternatives: ["Generic Substitute X"] },
      { severity: "high", hasAlternative: false },
    );
    expect(score.alternativeExistenceAgreed).toBe(false);
  });
});

describe("evaluatePromotion", () => {
  it("keeps a class in shadow until it has enough scored runs", () => {
    const decision = evaluatePromotion(stats({ runs: PROMOTION_GATES.suggest.minRuns - 1 }));
    expect(decision.stage).toBe("shadow");
    expect(decision.blockedBy.join(" ")).toContain("scored runs");
  });

  it("keeps a class in shadow when agreement is too low, however many runs it has", () => {
    expect(evaluatePromotion(stats({ runs: 10_000, meanAgreement: 0.5 })).stage).toBe("shadow");
  });

  it("promotes to suggest but not auto-draft in the middle band", () => {
    const decision = evaluatePromotion(stats({ runs: 25, meanAgreement: 0.85, severityAgreementRate: 0.9 }));
    expect(decision.stage).toBe("suggest");
    expect(decision.blockedBy.length).toBeGreaterThan(0);
  });

  it("blocks auto-draft on the severity bar alone — under-escalation is the dangerous direction", () => {
    const decision = evaluatePromotion(stats({ runs: 100, meanAgreement: 0.95, severityAgreementRate: 0.9 }));
    expect(decision.stage).toBe("suggest");
    expect(decision.blockedBy.join(" ")).toContain("severity agreement");
  });

  it("blocks promotion on under-escalation even when overall agreement looks fine", () => {
    // 90% severity agreement with every miss in the dangerous direction: the plain agreement
    // bars would pass `suggest`, the directional bar must not.
    const decision = evaluatePromotion(
      stats({ runs: 100, meanAgreement: 0.95, severityAgreementRate: 0.9, underEscalationRate: 0.1 }),
    );
    expect(decision.stage).toBe("shadow");
    expect(decision.blockedBy.join(" ")).toContain("under-escalation");
  });

  it("distinguishes the direction of a severity miss", () => {
    const under = scoreAgreement(
      { severity: "low", alternatives: ["a"] },
      { severity: "critical", hasAlternative: true },
    );
    const over = scoreAgreement(
      { severity: "critical", alternatives: ["a"] },
      { severity: "low", hasAlternative: true },
    );
    expect(under.severityUnderCalled).toBe(true);
    expect(over.severityUnderCalled).toBe(false);
    expect(under.agreement).toBe(over.agreement);
  });

  it("reaches auto-draft only when every bar is cleared", () => {
    expect(evaluatePromotion(stats()).stage).toBe("auto-draft");
  });
});

describe("replay corpus", () => {
  it("covers the labeled corpus with a baseline for every entry", () => {
    expect(REPLAY_CORPUS.length).toBeGreaterThanOrEqual(60);
    for (const entry of REPLAY_CORPUS) {
      expect(entry.baseline.severity.length).toBeGreaterThan(0);
      expect(entry.drugClass.length).toBeGreaterThan(0);
    }
  });

  it("groups into more than one class, or the per-class gates are meaningless", () => {
    expect(new Set(REPLAY_CORPUS.map((e) => e.drugClass)).size).toBeGreaterThan(1);
  });

  it("classifies biologics and oncology ahead of the generic injectable bucket", () => {
    const record: ShortageRecord = {
      genericName: "",
      key: "",
      source: "openfda",
      sourceId: "",
      status: "current",
      ndcs: [],
      rxcuis: [],
    };
    expect(drugClassFor({ ...record, genericName: "Immune Globulin (Human)" })).toBe("biologic");
    expect(drugClassFor({ ...record, genericName: "Cisplatin Injection" })).toBe("oncology");
    expect(drugClassFor({ ...record, genericName: "Heparin Sodium Injection" })).toBe("injectable");
    expect(drugClassFor({ ...record, genericName: "Levothyroxine Sodium Tablets" })).toBe("oral-inhaled");
  });
});

describe("promotion criteria name what is met, not only what is not", () => {
  const stats = (over: Partial<Parameters<typeof evaluatePromotion>[0]>) =>
    ({
      drugClass: "cephalosporin",
      runs: 0,
      meanAgreement: 0,
      severityAgreementRate: 0,
      underEscalationRate: 0,
      ...over,
    }) as Parameters<typeof evaluatePromotion>[0];

  it("reports every gate for the stage being worked towards, passing and failing alike", () => {
    // `blockedBy` alone reads the same one gate short as four. A director's question is which gate
    // to work on, and that needs the ones already met to be visible too.
    const decision = evaluatePromotion(stats({ runs: 25, meanAgreement: 0.95 }));
    expect(decision.criteria.map((c) => c.label)).toEqual([
      "scored runs",
      "mean agreement",
      "severity agreement",
      "under-escalation rate",
    ]);
    const byLabel = Object.fromEntries(decision.criteria.map((c) => [c.label, c]));
    expect(byLabel["scored runs"]?.met).toBe(true);
    expect(byLabel["scored runs"]?.actual).toBe("25");
    expect(byLabel["mean agreement"]?.met).toBe(true);
    expect(byLabel["severity agreement"]?.met).toBe(false);
  });

  it("compares the under-escalation gate as a ceiling, not a floor", () => {
    // The one gate where more is worse. Read as a floor, a class that under-escalates constantly
    // would pass it.
    const clean = evaluatePromotion(stats({ underEscalationRate: 0 }));
    const bad = evaluatePromotion(stats({ underEscalationRate: 0.5 }));
    const rate = (d: ReturnType<typeof evaluatePromotion>) =>
      d.criteria.find((c) => c.label === "under-escalation rate");
    expect(rate(clean)?.met).toBe(true);
    expect(rate(bad)?.met).toBe(false);
    expect(rate(bad)?.required).toContain("at most");
  });

  it("offers no criteria at the top stage, which is not the same as every gate met", () => {
    const top = evaluatePromotion(
      stats({ runs: 500, meanAgreement: 1, severityAgreementRate: 1, underEscalationRate: 0 }),
    );
    expect(top.stage).toBe("auto-draft");
    expect(top.criteria).toEqual([]);
  });
});
