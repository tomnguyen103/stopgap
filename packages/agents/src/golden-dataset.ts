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
    /** Severity should land in this set (agents may reasonably disagree within-bucket). */
    severityAtLeast: "none" | "low" | "moderate" | "high" | "critical";
    /** True if a real therapeutic alternative is expected to exist. */
    hasAlternative: boolean;
  };
}

const SEVERITY_RANK = ["none", "low", "moderate", "high", "critical"] as const;

export function severityMeetsFloor(actual: string, floor: string): boolean {
  return SEVERITY_RANK.indexOf(actual as (typeof SEVERITY_RANK)[number]) >= SEVERITY_RANK.indexOf(floor as (typeof SEVERITY_RANK)[number]);
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
    expected: { severityAtLeast: "none", hasAlternative: true },
  },
];
