import { describe, expect, it } from "vitest";

import { ladderPosition, type EscalationStep } from "./shared.js";

/**
 * The escalation ladder read from ELAPSED TIME (ticket 14).
 *
 * The director's unacknowledged-critical list is an anti-join: every row on it has no
 * acknowledgment at all. So a tier derived from `acknowledgments` reports "not yet escalated" for
 * every case however long it has burned — the one reading that cannot distinguish the case nobody
 * has seen for ten minutes from the one nobody has seen for ten hours. Time can.
 */
const STEPS: EscalationStep[] = [
  { afterMinutes: 15, notify: "on-call pharmacist" },
  { afterMinutes: 60, notify: "pharmacy director" },
  { afterMinutes: 240, notify: "medical director" },
];

describe("ladderPosition", () => {
  it("has reached nothing before the first rung is due", () => {
    expect(ladderPosition(STEPS, 5)).toEqual({ reached: [], next: STEPS[0] });
  });

  it("counts a rung as reached exactly at its delay, not a minute after", () => {
    // The boundary is the whole point: a rung due at 15 minutes and evaluated with `>` would
    // report the page as not yet owed at the moment it became owed.
    const at = ladderPosition(STEPS, 15);
    expect(at.reached.map((s) => s.notify)).toEqual(["on-call pharmacist"]);
    expect(at.next).toEqual(STEPS[1]);
  });

  it("names everyone the policy has already called for, not just the latest", () => {
    // "Who should know by now" is the question, and the answer is a list. Reporting only the
    // highest rung hides that the two below it also went unanswered.
    const at = ladderPosition(STEPS, 120);
    expect(at.reached.map((s) => s.notify)).toEqual(["on-call pharmacist", "pharmacy director"]);
    expect(at.next).toEqual(STEPS[2]);
  });

  it("reports no next rung once the ladder is exhausted", () => {
    const at = ladderPosition(STEPS, 10_000);
    expect(at.reached).toHaveLength(3);
    expect(at.next).toBeNull();
  });

  it("sorts the rungs rather than trusting their stored order", () => {
    // `escalation_policies.steps` is jsonb — nothing in the database keeps them ordered, and an
    // out-of-order rung would truncate the list at the first one that looked not-yet-due.
    const jumbled: EscalationStep[] = [STEPS[2]!, STEPS[0]!, STEPS[1]!];
    expect(ladderPosition(jumbled, 120).reached.map((s) => s.notify)).toEqual([
      "on-call pharmacist",
      "pharmacy director",
    ]);
  });

  it("returns an empty position for a severity with no policy configured", () => {
    expect(ladderPosition([], 500)).toEqual({ reached: [], next: null });
  });
});
