import { describe, expect, it } from "vitest";

import {
  bandSeverity,
  componentLabel,
  filterValue,
  dormantComponents,
  dormantPoints,
  pageCount,
  parseSignalListParams,
  partialScoreNotice,
  signalListHref,
  sortHref,
  toggleFilterHref,
  SIGNAL_LIST_SCHEMA,
} from "./signal-list.js";

describe("signal list state", () => {
  it("round-trips a view through the address", () => {
    const params = parseSignalListParams("q=heparin&sort=severity&dir=asc&page=3&domain=recall");
    expect(signalListHref(params, { page: 3 })).toBe(
      "?q=heparin&sort=severity&dir=asc&page=3&domain=recall",
    );
  });

  it("degrades a hand-edited address to defaults rather than erroring", () => {
    const params = parseSignalListParams(
      "sort=constructor&dir=sideways&page=-4&pageSize=99999&domain=badger",
    );
    expect(params.sort).toBe(SIGNAL_LIST_SCHEMA.defaultSort);
    expect(params.dir).toBe(SIGNAL_LIST_SCHEMA.defaultDir);
    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(SIGNAL_LIST_SCHEMA.defaultPageSize);
    expect(params.filters.domain ?? []).toEqual([]);
  });

  it("returns to page 1 when anything but the page changes", () => {
    const params = parseSignalListParams("page=7&sort=published");
    expect(sortHref(params, "severity")).toBe("?sort=severity");
    expect(toggleFilterHref(params, "domain", "shortage")).toBe("?domain=shortage");
    expect(signalListHref(params, { page: 8 })).toBe("?page=8");
  });

  it("reverses direction only on the column already sorted", () => {
    const published = parseSignalListParams("");
    expect(sortHref(published, "published")).toBe("?dir=asc");
    expect(sortHref(published, "entity")).toBe("?sort=entity");
  });

  it("removes a filter value that is already applied", () => {
    const params = parseSignalListParams("domain=recall");
    expect(toggleFilterHref(params, "domain", "recall")).toBe("?");
  });

  it("replaces rather than accumulates, because only one value reaches the query", () => {
    const params = parseSignalListParams("domain=recall");
    expect(toggleFilterHref(params, "domain", "shortage")).toBe("?domain=shortage");
    expect(filterValue(parseSignalListParams("domain=shortage"), "domain")).toBe("shortage");
    expect(filterValue(parseSignalListParams(""), "domain")).toBeUndefined();
  });

  it("allows exactly the freshness labels the contract stores", () => {
    // `recent` is not one of them — a value the schema allows and the column never holds is a
    // filter that returns nothing forever.
    expect(SIGNAL_LIST_SCHEMA.filters.freshness).toEqual(["fresh", "aging", "stale"]);
    expect(parseSignalListParams("freshness=recent").filters.freshness ?? []).toEqual([]);
    expect(parseSignalListParams("freshness=aging").filters.freshness).toEqual(["aging"]);
  });

  it("offers only sort keys the table renders a header for", () => {
    expect(SIGNAL_LIST_SCHEMA.sortKeys).toEqual(["published", "severity", "entity"]);
    expect(parseSignalListParams("sort=fetched").sort).toBe("published");
  });

  it("counts an empty list as one page", () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(50, 25)).toBe(2);
  });
});

describe("partial scores", () => {
  it("names the components the scorer could not reach", () => {
    expect(dormantComponents({ signalExposure: 41.2 })).toEqual(["daysOnHand", "soleSource"]);
    expect(dormantPoints({ signalExposure: 41.2 })).toBe(35);
    expect(partialScoreNotice({ signalExposure: 41.2 })).toBe(
      "Scored out of 65 of 100: days on hand and sole source stay dark until catalog data is loaded.",
    );
  });

  it("treats a component scored zero as present, not dormant", () => {
    expect(dormantComponents({ signalExposure: 12, daysOnHand: 0, soleSource: 0 })).toEqual([]);
    expect(partialScoreNotice({ signalExposure: 12, daysOnHand: 0, soleSource: 0 })).toBeNull();
  });

  it("says nothing about a case that was never scored", () => {
    expect(dormantComponents(null)).toEqual([]);
    expect(partialScoreNotice(null)).toBeNull();
  });

  it("labels every component the budget declares", () => {
    expect(componentLabel("daysOnHand")).toBe("Days on hand");
  });

  it("maps a scorer band onto the console's severity ramp, and nothing else", () => {
    expect(bandSeverity("critical")).toBe("critical");
    expect(bandSeverity(null)).toBe("none");
    expect(bandSeverity("unheard-of")).toBe("none");
  });
});
