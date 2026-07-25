import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/v1/cases` scopes to the KEY's organization (PHASE6 §6.5).
 *
 * Driving the REAL route handler, with the DB layer mocked at the module boundary and `withOrgDb`
 * stubbed to record the org it was opened for. The gate-level version of this assertion lives in
 * `lib/api-auth.test.ts`; this one covers the ROUTE, because that is where a per-endpoint mistake
 * would actually happen — a route that read an org from the query string, or that kept a default
 * from before the org was threaded, would pass the gate test and fail here.
 *
 * The hostile request deliberately supplies every plausible spelling of "act as another tenant".
 * None is read: the REST layer has no org parameter at all, which is what makes this impossible to
 * get wrong in one endpoint the way a validated parameter could be.
 */

vi.mock("server-only", () => ({}));

const KEY_ORG_ID = "dddddddd-0000-0000-0000-0000000000dd";
const SEED_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

const scopedOrgIds: string[] = [];
const listCases = vi.fn(async (_db: unknown, orgId: string, _limit: number) => [
  {
    workflowId: `org-${orgId}-case-heparin`,
    key: "heparin",
    genericName: "Heparin",
    status: "monitoring",
    severity: "critical",
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  },
]);

vi.mock("@stopgap/db", () => ({
  listCases: (...a: unknown[]) => listCases(...(a as Parameters<typeof listCases>)),
  withOrgDb: (orgId: string, fn: (db: unknown) => Promise<unknown>) => {
    scopedOrgIds.push(orgId);
    return fn({});
  },
}));

const apiKey = {
  id: "key-1",
  orgId: KEY_ORG_ID,
  name: "epic-integration",
  scopes: ["cases:read"],
  createdByUserId: null,
};

vi.mock("../../../lib/api-auth", () => ({
  authenticateApiRequest: async () => ({ ok: true, key: apiKey }),
}));

const { GET } = await import("./route");

beforeEach(() => {
  scopedOrgIds.length = 0;
  listCases.mockClear();
});

describe("GET /api/v1/cases (tenant scope)", () => {
  it("lists cases in the KEY's org", async () => {
    const response = await GET(new Request("https://console.test/api/v1/cases"));
    expect(response.status).toBe(200);
    expect(scopedOrgIds).toEqual([KEY_ORG_ID]);
    expect(listCases).toHaveBeenCalledWith({}, KEY_ORG_ID, 50);
  });

  it("ignores an org supplied in the query string or headers — the credential decides", async () => {
    const hostile = new Request(
      `https://console.test/api/v1/cases?orgId=${SEED_ORG_ID}&org=stopgap&limit=10`,
      { headers: { "x-org-id": SEED_ORG_ID } },
    );
    const response = await GET(hostile);
    expect(response.status).toBe(200);
    expect(scopedOrgIds).toEqual([KEY_ORG_ID]);
    // The `limit` parameter IS honoured — proof that query parsing happened at all, so the
    // assertion above is about the org being absent from the contract rather than about the route
    // ignoring the query string wholesale.
    expect(listCases).toHaveBeenCalledWith({}, KEY_ORG_ID, 10);
    expect(scopedOrgIds).not.toContain(SEED_ORG_ID);
  });
});
