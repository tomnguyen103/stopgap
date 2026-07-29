import { describe, expect, it } from "vitest";

import {
  describeRowError,
  isSoleSourced,
  parseCatalogListParams,
  CATALOG_LIST_SCHEMA,
  UPLOAD_KINDS,
} from "./catalog-list.js";

describe("catalog list state", () => {
  it("sorts by name ascending by default — a catalog is read alphabetically", () => {
    const params = parseCatalogListParams("");
    expect(params.sort).toBe("name");
    expect(params.dir).toBe("asc");
  });

  it("degrades a hand-edited address rather than erroring", () => {
    const params = parseCatalogListParams("sort=toString&dir=&page=0&sourcing=maybe&pageSize=0");
    expect(params.sort).toBe(CATALOG_LIST_SCHEMA.defaultSort);
    expect(params.dir).toBe("asc");
    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(CATALOG_LIST_SCHEMA.defaultPageSize);
    expect(params.filters.sourcing ?? []).toEqual([]);
  });

  it("carries a sourcing filter the query understands", () => {
    expect(parseCatalogListParams("sourcing=sole").filters.sourcing).toEqual(["sole"]);
  });

  it("offers every catalog kind the importer accepts", () => {
    // Transcribing the list would let the console drift from what `planImport` can read.
    expect(UPLOAD_KINDS).toContain("items");
    expect(UPLOAD_KINDS).toContain("suppliers");
    expect(UPLOAD_KINDS.length).toBeGreaterThan(2);
  });
});

describe("what an administrator is told", () => {
  it("calls a single-site item sole-sourced", () => {
    expect(isSoleSourced(1)).toBe(true);
    expect(isSoleSourced(0)).toBe(true);
    expect(isSoleSourced(2)).toBe(false);
  });

  it("puts the line first, and the column when the plan identified one", () => {
    expect(describeRowError({ line: 42, reason: "quantity is not a number" })).toBe(
      "Line 42: quantity is not a number",
    );
    expect(
      describeRowError({ line: 7, column: "days_on_hand", reason: "required column is empty" }),
    ).toBe("Line 7, column “days_on_hand”: required column is empty");
  });
});
