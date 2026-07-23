import type { ShortageRecord } from "@stopgap/core";

/**
 * Golden dataset v1 (PROJECT_PLAN §8: "golden dataset ~60-100 historical shortage cases
 * with labeled expected actions"). Small seed set to start the eval gate; grows over time —
 * each entry is a real-shaped shortage record with the human-reviewed expected outcome.
 */
export interface GoldenCase {
  id: string;
  record: ShortageRecord;
  expected: {
    /** Severity should land at or above this rung (agents may reasonably disagree within-bucket). */
    severityAtLeast: "none" | "low" | "moderate" | "high" | "critical";
    /**
     * Severity should land at or below this rung. Optional — most cases only need a floor;
     * set this when over-escalation itself is the failure mode being tested (e.g. a resolved
     * shortage that should NOT come back as "critical").
     */
    severityAtMost?: "none" | "low" | "moderate" | "high" | "critical";
    /** True if a real therapeutic alternative is expected to exist. */
    hasAlternative: boolean;
  };
}

const SEVERITY_RANK = ["none", "low", "moderate", "high", "critical"] as const;
type SeverityRank = (typeof SEVERITY_RANK)[number];

export function severityMeetsFloor(actual: string, floor: string): boolean {
  return SEVERITY_RANK.indexOf(actual as SeverityRank) >= SEVERITY_RANK.indexOf(floor as SeverityRank);
}

export function severityWithinCeiling(actual: string, ceiling: string): boolean {
  return SEVERITY_RANK.indexOf(actual as SeverityRank) <= SEVERITY_RANK.indexOf(ceiling as SeverityRank);
}

export const GOLDEN_DATASET: GoldenCase[] = [
  {
    id: "heparin-multi-ndc",
    record: {
      source: "openfda",
      sourceId: "0338-0431-03",
      key: "heparin sodium",
      genericName: "Heparin Sodium Injection",
      status: "current",
      ndcs: ["0338-0431-03", "0338-0433-04", "0338-0424-03", "0338-0428-02"],
      rxcuis: ["1658690"],
      note: "Manufacturing delay, no restock date.",
    },
    expected: { severityAtLeast: "high", hasAlternative: true },
  },
  {
    id: "immune-globulin-no-equivalent",
    record: {
      source: "ashp",
      sourceId: "ig-01",
      key: "immune globulin",
      genericName: "Immune Globulin (Human)",
      status: "current",
      ndcs: ["0069-0121-01"],
      rxcuis: [],
      note: "Plasma-derived product, industry-wide shortage.",
    },
    expected: { severityAtLeast: "moderate", hasAlternative: false },
  },
  {
    id: "single-ndc-minor",
    record: {
      source: "openfda",
      sourceId: "ndc-minor-1",
      key: "ondansetron",
      genericName: "Ondansetron Injection",
      status: "current",
      ndcs: ["0409-1234-01"],
      rxcuis: ["312938"],
      note: "One manufacturer's supply intermittently constrained; others available.",
    },
    expected: { severityAtLeast: "low", hasAlternative: true },
  },
  {
    id: "resolved-should-be-low-or-none",
    record: {
      source: "ashp",
      sourceId: "resolved-1",
      key: "cefazolin",
      genericName: "Cefazolin Injection",
      status: "resolved",
      ndcs: ["0143-9924-10"],
      rxcuis: ["2180"],
      note: "Manufacturer resumed full supply.",
    },
    // A resolved shortage never actually reaches these agents in production
    // (pollAndOpenCases only opens cases for status === "current") — this case exists purely
    // to check the severity ceiling doesn't over-escalate. A sensible agent reasonably
    // returns no alternatives for something already resolved (nothing to substitute for).
    expected: { severityAtLeast: "none", severityAtMost: "low", hasAlternative: false },
  },
];
