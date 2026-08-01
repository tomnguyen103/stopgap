import { describe, expect, it } from "vitest";
import { likeTerm, orderBy } from "./public-lists.js";
import { riskSignals } from "./schema.js";

/**
 * The two primitives that turn a caller's query string into SQL. Asserted offline because neither
 * is reachable from a route test: `api-list-query.ts` drops a bad `sort` before the query layer
 * ever sees it, so the second lock on that door can only be tested here, on the lock itself.
 */

describe("likeTerm", () => {
  it("wraps a plain term in wildcards", () => {
    expect(likeTerm("cefazolin")).toBe("%cefazolin%");
  });

  it("escapes the LIKE metacharacters, so a search for `%` is not a search for everything", () => {
    expect(likeTerm("%")).toBe("%\\%%");
    expect(likeTerm("a_b")).toBe("%a\\_b%");
    expect(likeTerm("back\\slash")).toBe("%back\\\\slash%");
  });
});

describe("orderBy", () => {
  const columns = { title: riskSignals.title, publishedAt: riskSignals.publishedAt };

  it("uses the requested column and direction", () => {
    const sql = orderBy(columns, riskSignals.publishedAt, {
      sort: "title",
      dir: "asc",
      limit: 1,
      offset: 0,
    });
    expect(sql.queryChunks.some((chunk) => chunk === riskSignals.title)).toBe(true);
  });

  it("falls back to the default column for an unknown sort key", () => {
    const sql = orderBy(columns, riskSignals.publishedAt, { sort: "org_id", limit: 1, offset: 0 });
    expect(sql.queryChunks.some((chunk) => chunk === riskSignals.publishedAt)).toBe(true);
  });

  it("falls back for an INHERITED property name — `?sort=constructor` is not a column", () => {
    // A bare `columns[sort]` returns `Object.prototype.constructor` here: a function, not
    // undefined, so the `?? fallback` would never fire and drizzle would be handed a non-column.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const sql = orderBy(columns, riskSignals.publishedAt, {
        sort: inherited,
        limit: 1,
        offset: 0,
      });
      expect(sql.queryChunks.some((chunk) => chunk === riskSignals.publishedAt)).toBe(true);
    }
  });
});
