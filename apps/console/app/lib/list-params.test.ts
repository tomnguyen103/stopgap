import { describe, expect, it } from "vitest";
import { parseListParams, serializeListParams, type ListParams, type ListParamsSchema } from "./list-params";

/**
 * List interaction state (unified-platform-spec, Phase F).
 *
 * Search, filter, sort and pagination live in the URL, and the parse/serialise pair is PURE — no
 * request, no framework, no rendering. That is the whole point of the seam: every table behaviour
 * the four dashboards share is asserted here, in the offline gate, instead of in a browser suite
 * that would break on a class-name change.
 *
 * The governing rule for every case below: a URL is attacker-supplied and user-editable, so a
 * malformed value DEGRADES TO A DEFAULT and never throws. A list page that 500s because someone
 * hand-edited `?page=-1` is a worse outcome than one that shows page 1.
 */

const schema = {
  sortKeys: ["score", "opened_at", "drug"],
  defaultSort: "score",
  defaultDir: "desc",
  filters: { severity: ["critical", "high", "moderate", "low"], status: ["open", "closed"] },
  pageSizes: [25, 50, 100],
  defaultPageSize: 25,
} as const satisfies ListParamsSchema;

/** The parsed shape when nothing is in the URL — the baseline every degrade case falls back to. */
const defaults: ListParams = {
  q: null,
  sort: "score",
  dir: "desc",
  page: 1,
  pageSize: 25,
  filters: {},
};

describe("parseListParams — defaults", () => {
  it("returns the schema's defaults for an empty query string", () => {
    expect(parseListParams("", schema)).toEqual(defaults);
  });

  it("accepts a URLSearchParams as readily as a string", () => {
    expect(parseListParams(new URLSearchParams(""), schema)).toEqual(defaults);
  });

  it("accepts Next's searchParams record shape", () => {
    expect(parseListParams({ q: "heparin" }, schema)).toEqual({ ...defaults, q: "heparin" });
  });
});

describe("parseListParams — search", () => {
  it("reads a search term", () => {
    expect(parseListParams("q=heparin", schema).q).toBe("heparin");
  });

  it("trims surrounding whitespace", () => {
    expect(parseListParams("q=%20heparin%20", schema).q).toBe("heparin");
  });

  it("treats a whitespace-only term as absent", () => {
    expect(parseListParams("q=%20%20", schema).q).toBeNull();
  });

  it("preserves inner whitespace and casing", () => {
    expect(parseListParams("q=Sodium%20Chloride", schema).q).toBe("Sodium Chloride");
  });

  it("caps an overlong term rather than passing it to the query layer", () => {
    const parsed = parseListParams(`q=${"x".repeat(500)}`, schema);
    expect(parsed.q).toHaveLength(200);
  });
});

describe("parseListParams — sort", () => {
  it("reads a sort key the schema allows", () => {
    expect(parseListParams("sort=drug", schema).sort).toBe("drug");
  });

  it("falls back to the default sort for a key the schema does not allow", () => {
    // The sort key reaches an ORDER BY. Anything not on the allow-list must never get that far.
    expect(parseListParams("sort=password", schema).sort).toBe("score");
  });

  it("reads an explicit direction", () => {
    expect(parseListParams("dir=asc", schema).dir).toBe("asc");
  });

  it("falls back to the default direction for a bad one", () => {
    expect(parseListParams("dir=sideways", schema).dir).toBe("desc");
  });

  it("is case-insensitive about direction", () => {
    expect(parseListParams("dir=ASC", schema).dir).toBe("asc");
  });
});

describe("parseListParams — pagination", () => {
  it("reads a page number", () => {
    expect(parseListParams("page=4", schema).page).toBe(4);
  });

  it.each(["0", "-3", "abc", "", "1.5", "NaN", "Infinity"])("clamps a bad page (%s) to 1", (bad) => {
    expect(parseListParams(`page=${bad}`, schema).page).toBe(1);
  });

  it("reads a page size the schema offers", () => {
    expect(parseListParams("pageSize=100", schema).pageSize).toBe(100);
  });

  it("falls back to the default for a page size the schema does not offer", () => {
    // Unbounded page size is a denial-of-service knob: ?pageSize=1000000 is one query away from
    // reading a whole tenant's table into memory.
    expect(parseListParams("pageSize=1000000", schema).pageSize).toBe(25);
  });
});

describe("parseListParams — filters", () => {
  it("reads a single filter value", () => {
    expect(parseListParams("severity=critical", schema).filters).toEqual({ severity: ["critical"] });
  });

  it("reads repeated params as a multi-value filter", () => {
    expect(parseListParams("severity=critical&severity=high", schema).filters).toEqual({
      severity: ["critical", "high"],
    });
  });

  it("keeps independent filters independent", () => {
    expect(parseListParams("severity=high&status=open", schema).filters).toEqual({
      severity: ["high"],
      status: ["open"],
    });
  });

  it("drops values the schema does not allow", () => {
    expect(parseListParams("severity=critical&severity=catastrophic", schema).filters).toEqual({
      severity: ["critical"],
    });
  });

  it("omits a filter entirely when every value was rejected", () => {
    expect(parseListParams("severity=catastrophic", schema).filters).toEqual({});
  });

  it("ignores a filter key the schema does not declare", () => {
    expect(parseListParams("org_id=someone-elses-tenant", schema).filters).toEqual({});
  });

  it("de-duplicates repeated identical values", () => {
    expect(parseListParams("severity=high&severity=high", schema).filters).toEqual({ severity: ["high"] });
  });
});

describe("serializeListParams", () => {
  it("emits nothing for the defaults, so a pristine view has a clean URL", () => {
    expect(serializeListParams(defaults, schema)).toBe("");
  });

  it("omits values equal to the schema default", () => {
    expect(serializeListParams({ ...defaults, sort: "score", dir: "desc" }, schema)).toBe("");
  });

  it("emits only what differs from the defaults", () => {
    expect(serializeListParams({ ...defaults, q: "heparin", page: 3 }, schema)).toBe("q=heparin&page=3");
  });

  it("emits repeated params for a multi-value filter", () => {
    const out = serializeListParams({ ...defaults, filters: { severity: ["critical", "high"] } }, schema);
    expect(out).toBe("severity=critical&severity=high");
  });

  it("orders output deterministically regardless of input key order", () => {
    const a = serializeListParams({ ...defaults, filters: { status: ["open"], severity: ["high"] } }, schema);
    const b = serializeListParams({ ...defaults, filters: { severity: ["high"], status: ["open"] } }, schema);
    expect(a).toBe(b);
  });

  it("percent-encodes a term with spaces and separators", () => {
    const out = serializeListParams({ ...defaults, q: "sodium chloride & water" }, schema);
    expect(out).toBe("q=sodium+chloride+%26+water");
    expect(parseListParams(out, schema).q).toBe("sodium chloride & water");
  });
});

describe("round-trip", () => {
  const cases: Array<Partial<ListParams>> = [
    {},
    { q: "heparin" },
    { page: 7 },
    { pageSize: 100 },
    { sort: "drug", dir: "asc" },
    { filters: { severity: ["critical", "high"] } },
    { q: "insulin lispro", sort: "opened_at", dir: "asc", page: 2, pageSize: 50, filters: { status: ["open"] } },
  ];

  it.each(cases)("parse(serialize(x)) === x for %j", (partial) => {
    const state = { ...defaults, ...partial };
    expect(parseListParams(serializeListParams(state, schema), schema)).toEqual(state);
  });

  it("is idempotent under repeated serialisation", () => {
    // A director sends a colleague a filtered link; the colleague changes a filter and sends it
    // back. The URL must not accrete parameters each hop.
    const once = serializeListParams({ ...defaults, q: "heparin", filters: { severity: ["high"] } }, schema);
    const twice = serializeListParams(parseListParams(once, schema), schema);
    expect(twice).toBe(once);
  });

  it("normalises a hand-edited URL to its canonical form", () => {
    const messy = "page=-1&sort=nonsense&severity=high&severity=bogus&dir=DESC&pageSize=99999";
    const canonical = serializeListParams(parseListParams(messy, schema), schema);
    expect(canonical).toBe("severity=high");
  });
});

describe("purity", () => {
  it("does not mutate the state it is given", () => {
    const state = { ...defaults, filters: { severity: ["high"] } };
    const snapshot = structuredClone(state);
    serializeListParams(state, schema);
    expect(state).toEqual(snapshot);
  });

  it("returns filter arrays that cannot alias back into the parsed result", () => {
    const parsed = parseListParams("severity=high", schema);
    parsed.filters.severity?.push("critical");
    expect(parseListParams("severity=high", schema).filters).toEqual({ severity: ["high"] });
  });
});
