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
    expect(score).toEqual({ agreement: 1, severityAgreed: true, alternativeExistenceAgreed: true });
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
