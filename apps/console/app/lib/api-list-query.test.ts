import { describe, expect, it } from "vitest";
import { API_LIST_SCHEMAS, parseApiListQuery, type ApiListQuery } from "./api-list-query";

/**
 * The public API's list vocabulary is the CONSOLE's list vocabulary (ticket 19: "list endpoints
 * support the same filtering and pagination vocabulary as the console").
 *
 * Asserted here, on the pure parser, because that is where the two could silently diverge: a route
 * that read its own `?limit=` would still return rows and still pass a tenant-scope test, while an
 * integrator who copied a console URL would get an unfiltered page and no error saying why.
 */

function query(resource: keyof typeof API_LIST_SCHEMAS, search: string): ApiListQuery {
  return parseApiListQuery(resource, new URL(`https://console.test/x?${search}`));
}

describe("parseApiListQuery", () => {
  it("reads the console's q/sort/dir/page/pageSize vocabulary", () => {
    const q = query("signals", "q=cefazolin&sort=severityScore&dir=asc&page=3&pageSize=100");
    expect(q.q).toBe("cefazolin");
    expect(q.sort).toBe("severityScore");
    expect(q.dir).toBe("asc");
    expect(q.limit).toBe(100);
    expect(q.offset).toBe(200);
  });

  it("degrades an unusable parameter to its default rather than refusing the request", () => {
    const q = query("signals", "sort=org_id&dir=sideways&page=-1&pageSize=99999");
    expect(q.sort).toBe(API_LIST_SCHEMAS.signals.defaultSort);
    expect(q.dir).toBe(API_LIST_SCHEMAS.signals.defaultDir);
    expect(q.offset).toBe(0);
    expect(q.limit).toBe(API_LIST_SCHEMAS.signals.defaultPageSize);
  });

  it("keeps only declared filter keys and declared values", () => {
    const q = query("signals", "riskDomain=shortage&riskDomain=nonsense&orgId=someone-else");
    expect(q.filters).toEqual({ riskDomain: ["shortage"] });
  });

  it("bands are the score list's filter, and score is its default ranking", () => {
    const q = query("scores", "band=critical&band=low");
    // Schema order, not URL order — the same canonicalisation the console relies on so that two
    // spellings of one filtered view are one cache key rather than two.
    expect(q.filters).toEqual({ band: ["low", "critical"] });
    expect(q.sort).toBe("score");
    expect(q.dir).toBe("desc");
  });

  it("catalog items search by sku, name or generic name and rank by sku", () => {
    const q = query("catalogItems", "q=  10mg vial  ");
    expect(q.q).toBe("10mg vial");
    expect(q.sort).toBe("sku");
  });
});
