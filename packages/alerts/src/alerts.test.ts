import { describe, expect, it } from "vitest";
import {
  evaluateAlerts,
  firingKey,
  nextEligibleAt,
  ruleMatches,
  summarize,
  type AlertRule,
  type AlertableSignal,
} from "./index.js";

const AT = "2026-07-28T12:00:00.000Z";

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "r1",
    name: "Critical shortages",
    enabled: true,
    minSeverity: "high",
    cooldownMinutes: 60,
    channels: ["email"],
    ...over,
  };
}

function signal(over: Partial<AlertableSignal> = {}): AlertableSignal {
  return {
    signalId: "s1",
    dedupeKey: "org:openfda_shortage:1",
    riskDomain: "shortage",
    entityIdentifier: "Heparin Sodium",
    severity: "high",
    score: 42,
    title: "Drug shortage — Heparin Sodium",
    ...over,
  };
}

describe("matching", () => {
  it("fires at or above the rule's severity floor, never below", () => {
    expect(ruleMatches(rule(), signal({ severity: "critical" }))).toBe(true);
    expect(ruleMatches(rule(), signal({ severity: "high" }))).toBe(true);
    expect(ruleMatches(rule(), signal({ severity: "moderate" }))).toBe(false);
  });

  it("refuses a severity this deployment has not been taught to read", () => {
    // Guessing that an unknown label clears a director's floor is the wrong direction to guess.
    expect(ruleMatches(rule(), signal({ severity: "catastrophic" }))).toBe(false);
  });

  it("scopes to a risk domain when one is named, and to any when not", () => {
    expect(ruleMatches(rule({ riskDomain: "recall" }), signal())).toBe(false);
    expect(ruleMatches(rule({ riskDomain: "shortage" }), signal())).toBe(true);
    expect(ruleMatches(rule(), signal({ riskDomain: "recall" }))).toBe(true);
  });

  it("matches an item by substring, case-insensitively", () => {
    // A facility says "heparin" and means every heparin product the feeds name, which they never
    // spell the same way twice.
    expect(ruleMatches(rule({ entityContains: "heparin" }), signal())).toBe(true);
    expect(ruleMatches(rule({ entityContains: "HEPARIN" }), signal())).toBe(true);
    expect(ruleMatches(rule({ entityContains: "saline" }), signal())).toBe(false);
  });

  it("never fires a disabled rule", () => {
    expect(ruleMatches(rule({ enabled: false }), signal({ severity: "critical" }))).toBe(false);
  });
});

describe("cooldowns", () => {
  it("turns a burst into ONE notification naming all of it", () => {
    const signals = Array.from({ length: 57 }, (_, i) =>
      signal({ signalId: `s${i}`, dedupeKey: `k${i}` }),
    );
    const result = evaluateAlerts({ rules: [rule()], signals, lastFiredAt: {}, evaluatedAt: AT });
    // The recorded incident: one ingestion run opened 57 cases. Without this, 57 notifications —
    // and what the recipient learns is to filter the channel.
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.matched).toHaveLength(57);
  });

  it("suppresses a rule inside its window and says when it is eligible again", () => {
    const lastFired = "2026-07-28T11:30:00.000Z";
    const result = evaluateAlerts({
      rules: [rule({ cooldownMinutes: 60 })],
      signals: [signal()],
      lastFiredAt: { r1: lastFired },
      evaluatedAt: AT,
    });
    expect(result.fired).toHaveLength(0);
    expect(result.suppressed[0]).toMatchObject({ reason: "cooldown" });
    expect(result.suppressed[0]?.nextEligibleAt).toBe("2026-07-28T12:30:00.000Z");
    // Suppressed, not dropped: "matched twelve and stayed quiet until 12:30" is what a director
    // tuning a rule needs to be able to read.
    expect(result.suppressed[0]?.matched).toHaveLength(1);
  });

  it("fires again once the window has passed", () => {
    const result = evaluateAlerts({
      rules: [rule({ cooldownMinutes: 60 })],
      signals: [signal()],
      lastFiredAt: { r1: "2026-07-28T10:59:00.000Z" },
      evaluatedAt: AT,
    });
    expect(result.fired).toHaveLength(1);
  });

  it("fires at the exact boundary rather than one evaluation late", () => {
    const result = evaluateAlerts({
      rules: [rule({ cooldownMinutes: 60 })],
      signals: [signal()],
      lastFiredAt: { r1: "2026-07-28T11:00:00.000Z" },
      evaluatedAt: AT,
    });
    expect(result.fired).toHaveLength(1);
  });

  it("computes the next eligible moment from the rule's own window", () => {
    expect(nextEligibleAt(rule({ cooldownMinutes: 15 }), AT)).toBe("2026-07-28T12:15:00.000Z");
  });

  it("keeps rules independent — one in cooldown does not silence another", () => {
    const result = evaluateAlerts({
      rules: [rule(), rule({ id: "r2", name: "Recalls", riskDomain: "shortage" })],
      signals: [signal()],
      lastFiredAt: { r1: "2026-07-28T11:59:00.000Z" },
      evaluatedAt: AT,
    });
    expect(result.fired.map((f) => f.rule.id)).toEqual(["r2"]);
    expect(result.suppressed.map((s) => s.rule.id)).toEqual(["r1"]);
  });

  it("says nothing at all when no signal matches", () => {
    const result = evaluateAlerts({
      rules: [rule()],
      signals: [signal({ severity: "low" })],
      lastFiredAt: {},
      evaluatedAt: AT,
    });
    expect(result).toEqual({ fired: [], suppressed: [] });
  });
});

describe("idempotency", () => {
  it("gives one firing the same key however many times it is evaluated", () => {
    expect(firingKey(rule(), AT)).toBe(firingKey(rule(), AT));
  });

  it("keeps the key stable across a retry that sees one more matching signal", () => {
    // The key is the rule and the WINDOW, not the signals — so a retried send is a no-op rather
    // than a second notification that happens to name one extra drug.
    const first = evaluateAlerts({
      rules: [rule()],
      signals: [signal()],
      lastFiredAt: {},
      evaluatedAt: AT,
    });
    const retry = evaluateAlerts({
      rules: [rule()],
      signals: [signal(), signal({ signalId: "s2", dedupeKey: "k2" })],
      lastFiredAt: {},
      evaluatedAt: AT,
    });
    expect(retry.fired[0]?.idempotencyKey).toBe(first.fired[0]?.idempotencyKey);
  });

  it("gives a different key in a later window", () => {
    expect(firingKey(rule({ cooldownMinutes: 60 }), "2026-07-28T13:00:00.000Z")).not.toBe(
      firingKey(rule({ cooldownMinutes: 60 }), AT),
    );
  });
});

describe("the notification body", () => {
  it("leads with the count, not with one drug's name", () => {
    const signals = Array.from({ length: 12 }, (_, i) =>
      signal({ signalId: `s${i}`, entityIdentifier: `Drug ${i}` }),
    );
    const [alert] = evaluateAlerts({
      rules: [rule()],
      signals,
      lastFiredAt: {},
      evaluatedAt: AT,
    }).fired;
    const { subject, body } = summarize(alert!);
    expect(subject).toBe("Critical shortages: 12 matching signals");
    expect(body).toContain("matched 12 signals");
  });

  it("caps the list and says how many it left out", () => {
    const signals = Array.from({ length: 57 }, (_, i) => signal({ signalId: `s${i}` }));
    const [alert] = evaluateAlerts({
      rules: [rule()],
      signals,
      lastFiredAt: {},
      evaluatedAt: AT,
    }).fired;
    const { body } = summarize(alert!, 10);
    // A message nobody scrolls is a message nobody read.
    expect(body).toContain("…and 47 more");
    expect(body.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(11);
  });

  it("says one signal in the singular", () => {
    const [alert] = evaluateAlerts({
      rules: [rule()],
      signals: [signal()],
      lastFiredAt: {},
      evaluatedAt: AT,
    }).fired;
    expect(summarize(alert!).subject).toBe("Critical shortages: 1 matching signal");
  });
});
