import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tenant resolution for a console request (PHASE6 §6.5).
 *
 * `resolvePrincipal` decides which hospital's data a request may touch, so it is the single most
 * security-relevant function in the console. These tests drive the REAL implementation with the
 * session, the cookie jar and the organization lookup mocked at the module boundary — no IdP, no
 * Postgres — and pin the four outcomes that matter:
 *
 *   1. a signed-in user gets THEIR OWN org;
 *   2. a NON-ADMIN's active-org cookie is ignored (a cookie is client-controlled state, so
 *      honouring it would hand tenant selection to anyone who can set a header);
 *   3. an ADMIN's cookie is honoured, but only when it names a real organization;
 *   4. the anonymous/demo viewer resolves to the seed org — the tenant the demo IS.
 */

vi.mock("server-only", () => ({}));

const SEED_ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const OWN_ORG_ID = "11111111-0000-0000-0000-000000000011";
const OTHER_ORG_ID = "22222222-0000-0000-0000-000000000022";

const auth = vi.fn();
vi.mock("../../auth", () => ({ auth: () => auth() }));

let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (_name: string) => (cookieValue === undefined ? undefined : { value: cookieValue }),
  }),
}));

const getOrganization = vi.fn(async (id: string) =>
  id === OTHER_ORG_ID || id === SEED_ORG_ID ? { id, slug: "other", name: "Other" } : undefined,
);
vi.mock("@stopgap/db", () => ({
  SEED_ORG_ID,
  getOrganization: (id: string) => getOrganization(id),
}));

vi.mock("@stopgap/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stopgap/core")>();
  // Only `getEnv` is stubbed — the role RANK that `rolesAllow` reads must stay REAL, or the
  // admin gate under test would be the mock's opinion rather than the app's policy.
  return { ...actual, getEnv: () => ({ STOPGAP_DEMO_MODE: "on" }) };
});

const { resolvePrincipal, ACTIVE_ORG_COOKIE } = await import("./principal");

function session(roles: string[], orgId = OWN_ORG_ID) {
  return { user: { id: "user-1", email: "dana@hospital.test", roles, orgId } };
}

beforeEach(() => {
  auth.mockReset();
  getOrganization.mockClear();
  cookieValue = undefined;
});

describe("resolvePrincipal (PHASE6 §6.5 tenant resolution)", () => {
  it("returns the signed-in user's OWN org when no active-org cookie is set", async () => {
    auth.mockResolvedValue(session(["pharmacist"]));
    const principal = await resolvePrincipal();
    expect(principal.orgId).toBe(OWN_ORG_ID);
    // No cookie, no lookup: the common path costs no extra round trip.
    expect(getOrganization).not.toHaveBeenCalled();
  });

  it("IGNORES the active-org cookie for a non-admin, silently keeping their own org", async () => {
    auth.mockResolvedValue(session(["pharmacy_director"]));
    cookieValue = OTHER_ORG_ID;
    const principal = await resolvePrincipal();
    // The whole isolation model would be defeated by one `document.cookie` if this were honoured,
    // and a pharmacy_director is deliberately included here: the rank stops BELOW admin.
    expect(principal.orgId).toBe(OWN_ORG_ID);
    expect(getOrganization).not.toHaveBeenCalled();
  });

  it("HONOURS the cookie for an admin when it names a real organization", async () => {
    auth.mockResolvedValue(session(["admin"]));
    cookieValue = OTHER_ORG_ID;
    const principal = await resolvePrincipal();
    expect(principal.orgId).toBe(OTHER_ORG_ID);
    expect(getOrganization).toHaveBeenCalledWith(OTHER_ORG_ID);
  });

  it("falls back to the admin's own org when the cookie names a NONEXISTENT organization", async () => {
    auth.mockResolvedValue(session(["admin"]));
    cookieValue = "99999999-0000-0000-0000-000000000099";
    const principal = await resolvePrincipal();
    // Not merely fail-closed at the database: an unverified id would set `app.current_org` to a
    // tenant that does not exist, which presents as an inexplicably empty console rather than as
    // "that is not an organization", and would let a stale cookie outlive the org it names.
    expect(principal.orgId).toBe(OWN_ORG_ID);
  });

  it("rejects a MALFORMED cookie without ever querying, resolving to the admin's own org", async () => {
    auth.mockResolvedValue(session(["admin"]));
    cookieValue = "'; drop table cases; --";
    const principal = await resolvePrincipal();
    expect(principal.orgId).toBe(OWN_ORG_ID);
    // The lookup must not happen at all. `organizations.id` is a `uuid` COLUMN, so a non-uuid does
    // not come back as "no such organization" — Postgres raises `invalid input syntax for type
    // uuid` from inside the comparison, uncaught, during a render every page awaits. One bad cookie
    // would 500 the whole console for that admin until it expired.
    expect(getOrganization).not.toHaveBeenCalled();
  });

  it("resolves the anonymous/demo viewer to the seed org, read-only", async () => {
    auth.mockResolvedValue(null);
    const principal = await resolvePrincipal();
    // The public demo IS the seed tenant — the org migration 0013 backfilled every
    // pre-multi-tenancy row into — so this is a statement of fact, not a fallback.
    expect(principal.orgId).toBe(SEED_ORG_ID);
    expect(principal.authenticated).toBe(false);
    // `viewer` holds no mutating role, so every action gate refuses this principal.
    expect(principal.roles).toEqual(["viewer"]);
    expect(principal.userId).toBeNull();
  });

  it("does not let an anonymous caller's cookie select a tenant", async () => {
    auth.mockResolvedValue(null);
    cookieValue = OTHER_ORG_ID;
    const principal = await resolvePrincipal();
    expect(principal.orgId).toBe(SEED_ORG_ID);
  });

  it("names the cookie once, so the switcher action and the resolver cannot drift apart", () => {
    expect(ACTIVE_ORG_COOKIE).toBe("stopgap_active_org");
  });
});
