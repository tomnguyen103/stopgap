import { describe, expect, it } from "vitest";
import type { OpenMonitoringCase } from "@stopgap/db";
import { diffResolutions } from "./feed-resolution.js";

/**
 * Pure feed-resolution tests (PHASE6 §6.6). The counting logic — reset on reappearance,
 * resolve on explicit `resolved`, resolve only after N consecutive misses — is exercised
 * without a database or a Temporal client. The multi-poll test feeds each poll's bump back in
 * to simulate consecutive polls, which is exactly how the counter accrues in production.
 */

const POLL_TS = "2026-07-24T00:00:00.000Z";

function monitoringCase(over: Partial<OpenMonitoringCase> = {}): OpenMonitoringCase {
  return {
    caseId: over.caseId ?? "case-1",
    key: over.key ?? "heparin sodium",
    source: over.source ?? "openfda",
    sourceId: over.sourceId ?? "0338-0431-03:Current",
    feedMissCount: over.feedMissCount ?? 0,
  };
}

const empty = { currentKeys: new Set<string>(), resolvedKeys: new Set<string>() };

describe("diffResolutions", () => {
  it("resets a case whose key is listed current again (only when the counter was non-zero)", () => {
    const cases = [monitoringCase({ feedMissCount: 2 })];
    const diff = diffResolutions(cases, { currentKeys: new Set(["heparin sodium"]), resolvedKeys: new Set() }, 3, POLL_TS);
    expect(diff.toReset).toEqual(["case-1"]);
    expect(diff.toBump).toEqual([]);
    expect(diff.toResolve).toEqual([]);
  });

  it("does not write a reset for a present key already at zero", () => {
    const cases = [monitoringCase({ feedMissCount: 0 })];
    const diff = diffResolutions(cases, { currentKeys: new Set(["heparin sodium"]), resolvedKeys: new Set() }, 3, POLL_TS);
    expect(diff.toReset).toEqual([]);
    expect(diff.toBump).toEqual([]);
    expect(diff.toResolve).toEqual([]);
  });

  it("bumps, without resolving, when a key is absent below threshold (flap protection)", () => {
    const diff = diffResolutions([monitoringCase({ feedMissCount: 0 })], empty, 3, POLL_TS);
    expect(diff.toBump).toEqual(["case-1"]);
    expect(diff.toResolve).toEqual([]);
  });

  it("resolves once absence reaches the threshold, citing evidence", () => {
    // Already missed twice; this poll is the third miss with a threshold of 3.
    const diff = diffResolutions([monitoringCase({ feedMissCount: 2 })], empty, 3, POLL_TS);
    expect(diff.toBump).toEqual([]);
    expect(diff.toResolve).toHaveLength(1);
    expect(diff.toResolve[0]).toMatchObject({
      caseId: "case-1",
      key: "heparin sodium",
      reason: "feed-absent",
      source: "openfda",
      lastSeenSourceId: "0338-0431-03:Current",
      consecutiveMisses: 3,
      missPollTimestamps: [POLL_TS],
    });
  });

  it("resolves immediately on an explicit resolved status, regardless of miss count", () => {
    const diff = diffResolutions(
      [monitoringCase({ feedMissCount: 0 })],
      { currentKeys: new Set(), resolvedKeys: new Set(["heparin sodium"]) },
      3,
      POLL_TS,
    );
    expect(diff.toResolve).toHaveLength(1);
    expect(diff.toResolve[0]).toMatchObject({ reason: "feed-resolved", consecutiveMisses: 0 });
    expect(diff.toResolve[0]!.missPollTimestamps).toEqual([]);
  });

  it("resolves only after N consecutive absent polls, never on a single flap", () => {
    const threshold = 3;
    let missCount = 0;
    let resolvedAt: number | undefined;
    // Simulate consecutive polls, feeding the bump back into the next poll's state.
    for (let poll = 1; poll <= threshold && resolvedAt === undefined; poll += 1) {
      const diff = diffResolutions([monitoringCase({ feedMissCount: missCount })], empty, threshold, POLL_TS);
      if (diff.toResolve.length > 0) resolvedAt = poll;
      else if (diff.toBump.length > 0) missCount += 1;
    }
    expect(resolvedAt).toBe(threshold);
  });

  it("a reappearance mid-streak clears the streak so resolution restarts from zero", () => {
    // Miss, miss, then the key comes back → reset. The counter is now 0 again.
    let missCount = 0;
    const bump = diffResolutions([monitoringCase({ feedMissCount: missCount })], empty, 3, POLL_TS);
    missCount += bump.toBump.length; // 1
    const reappear = diffResolutions(
      [monitoringCase({ feedMissCount: missCount })],
      { currentKeys: new Set(["heparin sodium"]), resolvedKeys: new Set() },
      3,
      POLL_TS,
    );
    expect(reappear.toReset).toEqual(["case-1"]);
    // After reset the case would carry feedMissCount 0 again — a single later miss must not resolve.
    const afterReset = diffResolutions([monitoringCase({ feedMissCount: 0 })], empty, 3, POLL_TS);
    expect(afterReset.toResolve).toEqual([]);
  });
});
