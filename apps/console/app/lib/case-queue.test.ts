import { describe, expect, it } from "vitest";

import {
  confidenceLabel,
  isException,
  parseCaseQueueParams,
  unavailableReason,
  CASE_QUEUE_SCHEMA,
  OPEN_CASE_STATUSES,
} from "./case-queue.js";

describe("case queue state", () => {
  it("ranks by score by default, because age is not risk", () => {
    const params = parseCaseQueueParams("");
    expect(params.sort).toBe("score");
    expect(params.dir).toBe("desc");
  });

  it("offers no terminal status as a filter", () => {
    expect(OPEN_CASE_STATUSES).not.toContain("closed");
    expect(OPEN_CASE_STATUSES).not.toContain("rejected");
    expect(OPEN_CASE_STATUSES).toContain("awaiting_review");
    expect(OPEN_CASE_STATUSES).toContain("exception");
    expect(parseCaseQueueParams("status=closed").filters.status ?? []).toEqual([]);
  });

  it("degrades a hand-edited address rather than erroring", () => {
    const params = parseCaseQueueParams("sort=__proto__&dir=up&page=0&severity=urgent");
    expect(params.sort).toBe(CASE_QUEUE_SCHEMA.defaultSort);
    expect(params.dir).toBe("desc");
    expect(params.page).toBe(1);
    expect(params.filters.severity ?? []).toEqual([]);
  });

  it("keeps the exception queue a reading of the case's own status", () => {
    expect(isException("exception")).toBe(true);
    expect(isException("awaiting_review")).toBe(false);
  });
});

describe("what a pharmacist is told", () => {
  it("shows the model's stated confidence as a percentage", () => {
    expect(confidenceLabel(0.42)).toBe("42%");
    expect(confidenceLabel(1)).toBe("100%");
  });

  it("says nothing at all when there is no model estimate", () => {
    // A protocol reused from memory, or written by a pharmacist, has no confidence — reporting
    // that as 0% would attribute a human decision to the model at its least certain.
    expect(confidenceLabel(undefined)).toBeNull();
  });

  it("names the role a disabled control needs", () => {
    expect(unavailableReason(false, "pharmacy_director", false)).toBe(
      "Needs the pharmacy_director role.",
    );
    expect(unavailableReason(true, "pharmacist", false)).toBeNull();
  });

  it("gives the demo its own reason, which is not a missing role", () => {
    expect(unavailableReason(true, "pharmacist", true)).toBe(
      "Disabled in the public demo — clinical decisions need a verified reviewer.",
    );
  });
});
