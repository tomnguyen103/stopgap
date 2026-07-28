import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ticket-19 read endpoints: signals, scores and catalog items.
 *
 * Three properties, asserted against the REAL route handlers with the DB layer mocked at the
 * module boundary:
 *
 *  1. **The org is the KEY's**, never anything in the request — the property that makes a leaked
 *     key one hospital's problem rather than the platform's.
 *  2. **The console's list vocabulary reaches the query layer.** A route that ignored `sort`/`page`
 *     would still return rows and still pass (1); an integrator copying a dashboard link would
 *     silently get the wrong page.
 *  3. **A key without the scope never reaches the query at all** — the gate's refusal is returned
 *     as-is rather than being second-guessed per route.
 */

vi.mock("server-only", () => ({}));

const KEY_ORG_ID = "dddddddd-0000-0000-0000-0000000000dd";
const OTHER_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

const scopedOrgIds: string[] = [];

const signalRow = {
  dedupeKey: "org:openfda-drug:abc",
  source: "openfda-drug",
  sourceId: "abc",
  riskDomain: "shortage",
  entityType: "drug",
  entityIdentifier: "cefazolin",
  title: "Cefazolin injection shortage",
  summary: "Supply disruption reported.",
  severity: "high",
  severityScore: "0.7000",
  confidence: "0.9000",
  staleness: "fresh",
  sourceResolved: false,
  observedAt: new Date("2026-07-01T00:00:00.000Z"),
  publishedAt: new Date("2026-07-02T00:00:00.000Z"),
  evidenceUrl: "https://api.fda.gov/drug/shortages.json",
};

const scoreRow = {
  dedupeKey: signalRow.dedupeKey,
  title: signalRow.title,
  riskDomain: "shortage",
  score: "72.50",
  band: "high",
  reachableMax: "100.00",
  scorerVersion: "scorer-1",
  computedAt: new Date("2026-07-02T06:00:00.000Z"),
};

const itemRow = {
  sku: "CEF-1G",
  name: "Cefazolin 1g vial",
  genericName: "cefazolin",
  unit: "vial",
  updatedAt: new Date("2026-07-02T00:00:00.000Z"),
};

const listSignalsPage = vi.fn(async () => ({ rows: [signalRow], total: 1 }));
const listScoresPage = vi.fn(async () => ({ rows: [scoreRow], total: 1 }));
const listCatalogItemsPage = vi.fn(async () => ({ rows: [itemRow], total: 1 }));
const getSignalPublic = vi.fn(async (_db: unknown, _orgId: string, key: string) =>
  key === signalRow.dedupeKey ? signalRow : undefined,
);

vi.mock("@stopgap/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stopgap/db")>();
  return {
    API_SCOPES: actual.API_SCOPES,
    isApiScope: actual.isApiScope,
    listSignalsPage: (...a: unknown[]) => listSignalsPage(...(a as [])),
    listScoresPage: (...a: unknown[]) => listScoresPage(...(a as [])),
    listCatalogItemsPage: (...a: unknown[]) => listCatalogItemsPage(...(a as [])),
    getSignalPublic: (...a: unknown[]) =>
      getSignalPublic(...(a as Parameters<typeof getSignalPublic>)),
    withOrgDb: (orgId: string, fn: (db: unknown) => Promise<unknown>) => {
      scopedOrgIds.push(orgId);
      return fn({});
    },
  };
});

/** Scopes the fake key carries. Mutated per test to exercise the refusal path. */
let heldScopes: string[] = ["signals:read", "scores:read", "catalog:read"];

vi.mock("../../../lib/api-auth", () => ({
  authenticateApiRequest: async (_request: Request, scope: string) =>
    heldScopes.includes(scope)
      ? { ok: true, key: { id: "key-1", orgId: KEY_ORG_ID, name: "planner", scopes: heldScopes, createdByUserId: null } }
      : { ok: false, response: Response.json({ error: "forbidden", message: scope }, { status: 403 }) },
}));

const { GET: getSignals } = await import("./route");
const { GET: getSignal } = await import("./[key]/route");
const { GET: getScores } = await import("../scores/route");
const { GET: getItems } = await import("../catalog/items/route");

beforeEach(() => {
  scopedOrgIds.length = 0;
  heldScopes = ["signals:read", "scores:read", "catalog:read"];
  for (const spy of [listSignalsPage, listScoresPage, listCatalogItemsPage, getSignalPublic]) spy.mockClear();
});

describe("GET /api/v1/signals", () => {
  it("lists in the KEY's org and converts numerics to numbers", async () => {
    const response = await getSignals(new Request("https://console.test/api/v1/signals"));
    expect(response.status).toBe(200);
    expect(scopedOrgIds).toEqual([KEY_ORG_ID]);
    const body = (await response.json()) as {
      signals: { key: string; severityScore: number }[];
      page: { page: number; pageSize: number; total: number };
    };
    expect(body.signals[0]?.severityScore).toBe(0.7);
    expect(body.page).toEqual({ page: 1, pageSize: 50, total: 1 });
  });

  it("ignores an org supplied in the query string or headers — the credential decides", async () => {
    const hostile = new Request(`https://console.test/api/v1/signals?orgId=${OTHER_ORG_ID}&org=stopgap`, {
      headers: { "x-org-id": OTHER_ORG_ID },
    });
    expect((await getSignals(hostile)).status).toBe(200);
    expect(scopedOrgIds).toEqual([KEY_ORG_ID]);
    expect(scopedOrgIds).not.toContain(OTHER_ORG_ID);
  });

  it("passes the console's sort, direction, page and filters through to the query", async () => {
    await getSignals(
      new Request("https://console.test/api/v1/signals?sort=title&dir=asc&page=2&pageSize=25&riskDomain=recall&q=cef"),
    );
    expect(listSignalsPage).toHaveBeenCalledWith(
      {},
      KEY_ORG_ID,
      expect.objectContaining({
        sort: "title",
        dir: "asc",
        limit: 25,
        offset: 25,
        q: "cef",
        filters: { riskDomain: ["recall"] },
      }),
    );
  });

  it("refuses a key without the scope before opening any transaction", async () => {
    heldScopes = ["cases:read"];
    const response = await getSignals(new Request("https://console.test/api/v1/signals"));
    expect(response.status).toBe(403);
    expect(listSignalsPage).not.toHaveBeenCalled();
    expect(scopedOrgIds).toEqual([]);
  });
});

describe("GET /api/v1/signals/{key}", () => {
  it("returns the signal in the key's org", async () => {
    const response = await getSignal(new Request("https://console.test/api/v1/signals/x"), {
      params: Promise.resolve({ key: signalRow.dedupeKey }),
    });
    expect(response.status).toBe(200);
    expect(scopedOrgIds).toEqual([KEY_ORG_ID]);
  });

  it("answers 404 — not 403 — for a key another tenant holds", async () => {
    const response = await getSignal(new Request("https://console.test/api/v1/signals/x"), {
      params: Promise.resolve({ key: "someone-elses-signal" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/scores", () => {
  it("ranks on the scorer's number and scopes to the key's org", async () => {
    const response = await getScores(new Request("https://console.test/api/v1/scores?band=critical"));
    expect(response.status).toBe(200);
    expect(scopedOrgIds).toEqual([KEY_ORG_ID]);
    expect(listScoresPage).toHaveBeenCalledWith(
      {},
      KEY_ORG_ID,
      expect.objectContaining({ sort: "score", dir: "desc", filters: { band: ["critical"] } }),
    );
    const body = (await response.json()) as { scores: { score: number; signalKey: string }[] };
    expect(body.scores[0]).toMatchObject({ score: 72.5, signalKey: signalRow.dedupeKey });
  });

  it("refuses a key that holds signals:read but not scores:read", async () => {
    heldScopes = ["signals:read"];
    expect((await getScores(new Request("https://console.test/api/v1/scores"))).status).toBe(403);
    expect(listScoresPage).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/catalog/items", () => {
  it("lists items in the key's org, without quantities or suppliers", async () => {
    const response = await getItems(new Request("https://console.test/api/v1/catalog/items?q=cef"));
    expect(response.status).toBe(200);
    expect(scopedOrgIds).toEqual([KEY_ORG_ID]);
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      ["genericName", "name", "sku", "unit", "updatedAt"].sort(),
    );
  });
});
