import { describe, expect, it } from "vitest";

import { clampPage, dedupeByKey } from "./signals.js";

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

/**
 * The page clamp, asserted offline.
 *
 * Every value here is one Postgres refuses rather than returns nothing for: a negative OFFSET, a
 * fractional OFFSET, `OFFSET NaN`. The console's own parser never produces them — but the
 * paginators this guards are exported from `@stopgap/db`, and a caller that is not that parser is
 * the entire reason the clamp exists, so the guarantee is pinned here rather than assumed.
 */
describe("clampPage", () => {
  it("clamps a page past the end to the last page", () => {
    expect(clampPage(500, 25, 10)).toBe(3);
  });

  it("floors at 1, so OFFSET is never negative", () => {
    expect(clampPage(0, 25, 10)).toBe(1);
    expect(clampPage(-7, 25, 10)).toBe(1);
  });

  it("returns page 1 for an empty result rather than page 0", () => {
    expect(clampPage(1, 0, 10)).toBe(1);
    expect(clampPage(9, 0, 10)).toBe(1);
  });

  it("truncates a fractional page — `OFFSET 12.5` is an error, not an empty page", () => {
    expect(clampPage(2.7, 100, 10)).toBe(2);
  });

  it("falls back to page 1 for NaN, which min and max both pass straight through", () => {
    expect(clampPage(Number.NaN, 100, 10)).toBe(1);
  });

  it("treats an infinity as an overshoot in that direction, not as a special case", () => {
    expect(clampPage(Number.POSITIVE_INFINITY, 100, 10)).toBe(10);
    expect(clampPage(Number.NEGATIVE_INFINITY, 100, 10)).toBe(1);
  });

  it("leaves a page already in range alone", () => {
    expect(clampPage(2, 100, 10)).toBe(2);
  });

  it("refuses a page size that cannot produce a page at all", () => {
    // Unlike `page`, a bad `pageSize` has no nearest-sensible answer: it reaches `LIMIT` directly,
    // where 0 silently returns an empty page and the rest are errors from Postgres. Refusing names
    // the caller's bug instead of inventing a default it never asked for.
    for (const bad of [0, -10, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => clampPage(1, 100, bad)).toThrow(RangeError);
    }
    expect(() => clampPage(1, 100, 10)).not.toThrow();
  });
});
