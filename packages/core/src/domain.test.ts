import { describe, expect, it } from "vitest";
import { CaseStatus, ShortageRecord, isTerminalStatus } from "./domain.js";

describe("ShortageRecord", () => {
  it("parses a minimal openFDA record and defaults ndcs to []", () => {
    const r = ShortageRecord.parse({
      source: "openfda",
      sourceId: "abc-123",
      key: "heparin sodium",
      genericName: "Heparin Sodium",
      status: "current",
    });
    expect(r.ndcs).toEqual([]);
    expect(r.source).toBe("openfda");
  });

  it("rejects an unknown feed source", () => {
    expect(() =>
      ShortageRecord.parse({
        source: "who",
        sourceId: "x",
        key: "k",
        genericName: "g",
        status: "current",
      }),
    ).toThrow();
  });
});

describe("case status", () => {
  it("treats closed and rejected as terminal", () => {
    expect(isTerminalStatus("closed")).toBe(true);
    expect(isTerminalStatus("rejected")).toBe(true);
    expect(isTerminalStatus("monitoring")).toBe(false);
  });

  it("enumerates the full lifecycle", () => {
    expect(CaseStatus.options).toContain("awaiting_review");
    expect(CaseStatus.options).toContain("exception");
  });
});
