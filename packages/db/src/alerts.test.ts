import { describe, expect, it } from "vitest";
import { createAlertRule, updateAlertRule } from "./alerts.js";

/**
 * One hazard: which webhook `assertRuleVocabulary` is allowed to ask about.
 *
 * A chat webhook is a bearer credential, so `updateAlertRule` treats an OMITTED `chatWebhookUrl`
 * as "keep the stored one" — that preservation is what lets the rules panel tune a cooldown
 * without ever being handed the secret. The guard, however, used to read `input.chatWebhookUrl`,
 * which asks whether the EDITOR supplied a credential rather than whether the RULE has one. Every
 * edit of a chat rule from that panel was therefore refused with "a chat rule needs a webhook to
 * deliver to" — on a rule that had one the whole time.
 *
 * No live database: the guard runs before any SQL, so a fake implementing just enough of the
 * drizzle chain answers the only question these tests ask — did the write get past the guard, and
 * with what.
 */

const ORG = "aaaaaaaa-0000-0000-0000-0000000000a1";
const RULE_ID = "rule-uuid-1";

/** A stored rule that already HAS a webhook, which the editor is not going to send back. */
const STORED = { chatWebhookUrl: "https://chat.example.test/hooks/stored-secret" };

/** The subset of the drizzle select/insert/update chain these two functions use. */
function fakeDb(existing: Record<string, unknown>[]) {
  const writes: Record<string, unknown>[] = [];
  /** Every predicate handed to `.where()`, so a test can assert the pre-read is org-scoped. */
  const wheres: unknown[] = [];
  const chain = (result: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const method of ["from", "returning"]) self[method] = () => self;
    self.where = (predicate: unknown) => {
      wheres.push(predicate);
      return self;
    };
    self.set = (values: Record<string, unknown>) => {
      writes.push(values);
      return self;
    };
    self.values = (values: Record<string, unknown>) => {
      writes.push(values);
      return self;
    };
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return self;
  };
  const db: Record<string, unknown> = {
    select: () => chain(existing),
    // The row the write returns is irrelevant here; only reaching the write matters.
    update: () => chain([{ id: RULE_ID }]),
    insert: () => chain([{ id: RULE_ID }]),
  };
  // `updateAlertRule` reads and writes inside one transaction, so the fake has to offer one. It
  // hands back the same object: there is no isolation to model here, only the call shape.
  db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db: db as never, writes, wheres };
}

/**
 * Does a captured drizzle predicate mention this value?
 *
 * Walks the object rather than stringifying it: a drizzle SQL node holds references back to its
 * table, so `JSON.stringify` hits a circular structure. The `seen` set is what makes the walk
 * terminate on exactly that shape.
 */
function mentions(predicate: unknown, value: string): boolean {
  const seen = new Set<unknown>();
  const visit = (node: unknown): boolean => {
    if (node === value) return true;
    if (node === null || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    return Object.values(node as Record<string, unknown>).some(visit);
  };
  return visit(predicate);
}

const CHAT_RULE = {
  name: "critical shortages to the pharmacy room",
  minSeverity: "critical" as const,
  cooldownMinutes: 60,
  channels: ["chat"],
};

describe("a chat rule's webhook is validated against what the rule will HAVE", () => {
  it("accepts an edit that omits the webhook, because the stored one is preserved", async () => {
    const { db, writes } = fakeDb([STORED]);
    await expect(updateAlertRule(db, ORG, RULE_ID, { ...CHAT_RULE })).resolves.toBeDefined();
    // Preserved, not rewritten: the key is absent from the update entirely, so the editor never
    // needed the credential in order to change the cooldown.
    expect(writes[0]).not.toHaveProperty("chatWebhookUrl");
  });

  it("still refuses an edit that clears the webhook explicitly on a chat rule", async () => {
    const { db } = fakeDb([STORED]);
    await expect(
      updateAlertRule(db, ORG, RULE_ID, { ...CHAT_RULE, chatWebhookUrl: null }),
    ).rejects.toThrow(/needs a webhook/);
  });

  it("still refuses an edit that omits the webhook when the rule has none stored", async () => {
    const { db } = fakeDb([{ chatWebhookUrl: null }]);
    await expect(updateAlertRule(db, ORG, RULE_ID, { ...CHAT_RULE })).rejects.toThrow(
      /needs a webhook/,
    );
  });

  it("reports a missing rule as undefined rather than as a missing webhook", async () => {
    // Otherwise editing a rule someone else just deleted sends the reader looking for the wrong
    // problem — a credential error about a rule that does not exist.
    const { db } = fakeDb([]);
    await expect(updateAlertRule(db, ORG, RULE_ID, { ...CHAT_RULE })).resolves.toBeUndefined();
  });

  it("still refuses a CREATE with no webhook, where there is nothing stored to preserve", async () => {
    const { db } = fakeDb([]);
    await expect(createAlertRule(db, ORG, { ...CHAT_RULE })).rejects.toThrow(/needs a webhook/);
  });

  it("accepts a create that supplies one", async () => {
    const { db } = fakeDb([]);
    await expect(
      createAlertRule(db, ORG, { ...CHAT_RULE, chatWebhookUrl: STORED.chatWebhookUrl }),
    ).resolves.toBeDefined();
  });
});

describe("the pre-read is scoped to the caller's tenant", () => {
  it("filters by org, not by rule id alone", async () => {
    // The gap this closes: the fake used to ignore `.where()` entirely, so deleting
    // `eq(alertRules.orgId, orgId)` from the pre-read left every case in this file passing. The
    // pre-read decides what the guard validates against — unscoped, it reads ANOTHER tenant's
    // webhook state and lets a chat rule through on the strength of it.
    const { db, wheres } = fakeDb([STORED]);
    await updateAlertRule(db, ORG, RULE_ID, {
      name: "r",
      minSeverity: "high",
      cooldownMinutes: 60,
      channels: ["chat"],
    });
    expect(wheres.length).toBeGreaterThan(0);
    expect(mentions(wheres[0], ORG)).toBe(true);
    expect(mentions(wheres[0], RULE_ID)).toBe(true);
  });
});
