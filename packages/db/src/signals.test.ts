import { describe, expect, it } from "vitest";

import { dedupeByKey } from "./signals.js";

/**
 * Batch collapsing, asserted offline.
 *
 * The bug this covers is invisible in TypeScript and fatal in Postgres: `ON CONFLICT DO UPDATE`
 * refuses a statement that touches the same row twice, so ONE repeated dedupe key in a poll's batch
 * aborts that tenant's entire write — every signal, silently, every poll, for as long as the feed
 * keeps reporting the pair. The collapse is pure, so it is asserted here rather than behind the
 * database-only suite.
 */
describe("dedupeByKey", () => {
  it("keeps one entry per dedupe key", () => {
    const out = dedupeByKey([
      { dedupeKey: "org:a", title: "first" },
      { dedupeKey: "org:b", title: "other" },
      { dedupeKey: "org:a", title: "second" },
    ]);
    expect(out.map((s) => s.dedupeKey)).toEqual(["org:a", "org:b"]);
  });

  it("keeps the LAST occurrence, which is the feed's more recent statement", () => {
    const out = dedupeByKey([
      { dedupeKey: "org:a", title: "stale" },
      { dedupeKey: "org:a", title: "current" },
    ]);
    expect(out).toEqual([{ dedupeKey: "org:a", title: "current" }]);
  });

  it("leaves a batch with no repeats in its original order", () => {
    const batch = [{ dedupeKey: "org:a" }, { dedupeKey: "org:b" }, { dedupeKey: "org:c" }];
    expect(dedupeByKey(batch)).toEqual(batch);
  });

  it("returns nothing for an empty batch", () => {
    expect(dedupeByKey([])).toEqual([]);
  });
});
