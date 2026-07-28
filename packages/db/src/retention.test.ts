import { describe, expect, it } from "vitest";
import {
  RETAINED_FOREVER,
  RETENTION_KINDS,
  retentionPlan,
  type RetentionWindows,
} from "./retention.js";

/**
 * The retention POLICY — which records a sweep is allowed to remove, and from when.
 *
 * Pure and tested offline because the consequential half of a cleanup job is not the DELETE, it is
 * the arithmetic that decides what the DELETE will see. A cutoff off by a factor of a thousand
 * removes a year of evidence and reports success.
 */

const WINDOWS: RetentionWindows = {
  riskSignals: 180,
  riskScoreSnapshots: 180,
  alertEvents: 90,
  inventorySnapshots: 365,
  procurementEvents: 365,
};

const NOW = new Date("2026-07-28T12:00:00.000Z");

describe("retentionPlan", () => {
  it("computes one cutoff per record kind, `days` before now", () => {
    const plan = retentionPlan(NOW, WINDOWS);
    expect(plan.map((entry) => entry.kind).sort()).toEqual([...RETENTION_KINDS].sort());
    const alerts = plan.find((entry) => entry.kind === "alertEvents");
    expect(alerts?.cutoff.toISOString()).toBe("2026-04-29T12:00:00.000Z");
  });

  it("omits a kind whose window says keep forever, rather than deleting everything", () => {
    // The dangerous reading of 0 is "cutoff = now", which removes the whole table. A window has to
    // be able to say "never sweep this" without that being spelled as a number the arithmetic can
    // misread.
    const plan = retentionPlan(NOW, { ...WINDOWS, riskSignals: RETAINED_FOREVER });
    expect(plan.map((entry) => entry.kind)).not.toContain("riskSignals");
    expect(plan).not.toHaveLength(0);
  });

  it("never plans a sweep of the audit chain or its anchors", () => {
    // Ticket 18: "audit chain integrity survives cleanup". The chain is hash-linked and externally
    // anchored, so removing an entry does not free space — it makes every later entry unverifiable
    // and makes the anchor report tampering that never happened. It is therefore not a retention
    // KIND at all: there is no window that could switch it on.
    expect(RETENTION_KINDS).not.toContain("auditLog");
    expect(RETENTION_KINDS).not.toContain("auditAnchors");
  });

  it("refuses a negative window rather than computing a cutoff in the future", () => {
    // A future cutoff sweeps rows that have not aged yet — every row, in practice.
    expect(() => retentionPlan(NOW, { ...WINDOWS, alertEvents: -1 })).toThrow(/alertEvents/);
  });
});
