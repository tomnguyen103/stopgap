import { ROLES, type Role } from "@stopgap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "./principal";

/**
 * RBAC tests (PHASE6 §6.1). The session read is mocked so the whole matrix is exercised without
 * NextAuth, a live IdP, or a database — the pure authorization logic (`authz.ts`) is the source
 * of truth, and `requireRole` is proven to be the thin, server-enforced wrapper over it. The
 * headline case: a pharmacist session CANNOT approve a protocol version (privilege escalation
 * fails on the server, not merely in a hidden button).
 */

// `auth-guards` imports "server-only", whose sole job is to throw outside a server bundle — a
// no-op module under vitest lets us test the guard in plain node.
vi.mock("server-only", () => ({}));

const resolvePrincipal = vi.fn<() => Promise<Principal>>();
vi.mock("./principal", () => ({ resolvePrincipal: () => resolvePrincipal() }));

// Imported after the mock is registered so `auth-guards` binds the mocked `resolvePrincipal`.
const { requireRole } = await import("./auth-guards");
const {
  AuthorizationError,
  isActionAllowed,
  ACTION_MIN_ROLE,
  CONSOLE_ACTIONS,
  roleSatisfies,
  roleLandingRoute,
  canViewGroup,
  hasRecognizedRole,
  ACCESS_DENIED_ROUTE,
  DASHBOARD_GROUPS,
  ROLE_LANDING_ROUTE,
} = await import("./authz");

function principal(roles: Role[]): Principal {
  return {
    userId: roles.length > 0 ? "11111111-1111-1111-1111-111111111111" : null,
    label: roles.length > 0 ? "dr@hospital.test" : "anonymous",
    roles,
    authenticated: roles.length > 0,
    // Every principal carries the tenant it acts in (PHASE6 §6.5). Not optional and not blank:
    // the guards return the principal to the caller, which passes `orgId` straight to `withOrgDb`,
    // and a fixture with an empty value would type-check while the real path threw.
    orgId: "00000000-0000-0000-0000-0000000000a1",
  };
}

beforeEach(() => {
  resolvePrincipal.mockReset();
});

describe("role rank", () => {
  it("orders viewer < pharmacist < pharmacy_director < admin", () => {
    expect(roleSatisfies("admin", "viewer")).toBe(true);
    expect(roleSatisfies("pharmacy_director", "pharmacist")).toBe(true);
    expect(roleSatisfies("pharmacist", "pharmacy_director")).toBe(false);
    expect(roleSatisfies("viewer", "pharmacist")).toBe(false);
  });
});

describe("isActionAllowed matrix (role × action)", () => {
  // The full truth table: a role is allowed iff its rank meets the action's minimum.
  const expectations: Record<Role, Record<string, boolean>> = {
    viewer: {
      review_case: false,
      resolve_exception: false,
      approve_protocol_version: false,
      manage_alert_rules: false,
      manage_catalog: false,
      manage_users: false,
      manage_api_keys: false,
    },
    pharmacist: {
      review_case: true,
      resolve_exception: true,
      approve_protocol_version: false,
      manage_alert_rules: false,
      manage_catalog: false,
      manage_users: false,
      manage_api_keys: false,
    },
    pharmacy_director: {
      review_case: true,
      resolve_exception: true,
      approve_protocol_version: true,
      manage_alert_rules: true,
      manage_catalog: false,
      manage_users: false,
      manage_api_keys: false,
    },
    admin: {
      review_case: true,
      resolve_exception: true,
      approve_protocol_version: true,
      manage_alert_rules: true,
      manage_catalog: true,
      manage_users: true,
      manage_api_keys: true,
    },
  };

  for (const role of ROLES) {
    for (const action of CONSOLE_ACTIONS) {
      it(`${role} ${expectations[role][action] ? "may" : "may not"} ${action}`, () => {
        expect(isActionAllowed([role], action)).toBe(expectations[role][action]);
      });
    }
  }

  it("every action has a defined minimum role", () => {
    for (const action of CONSOLE_ACTIONS) expect(ACTION_MIN_ROLE[action]).toBeDefined();
  });
});

describe("requireRole (server-enforced guard)", () => {
  it("lets a pharmacist review a case and returns the authenticated principal", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    const p = await requireRole("review_case");
    expect(p.userId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("lets a pharmacist resolve an exception", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(requireRole("resolve_exception")).resolves.toMatchObject({ authenticated: true });
  });

  it("REFUSES a pharmacist approving a protocol version (privilege escalation fails server-side)", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(requireRole("approve_protocol_version")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("REFUSES a pharmacist managing users", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(requireRole("manage_users")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("lets a pharmacy_director approve a protocol version", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    await expect(requireRole("approve_protocol_version")).resolves.toMatchObject({
      authenticated: true,
    });
  });

  it("REFUSES a pharmacy_director managing users", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    await expect(requireRole("manage_users")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("lets an admin manage users", async () => {
    resolvePrincipal.mockResolvedValue(principal(["admin"]));
    await expect(requireRole("manage_users")).resolves.toMatchObject({ authenticated: true });
  });

  it("REFUSES the anonymous viewer (demo/unauthenticated) every mutation", async () => {
    resolvePrincipal.mockResolvedValue(principal(["viewer"]));
    for (const action of CONSOLE_ACTIONS) {
      await expect(requireRole(action)).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("honours a multi-role user by their highest role", async () => {
    resolvePrincipal.mockResolvedValue(principal(["viewer", "pharmacy_director"]));
    await expect(requireRole("approve_protocol_version")).resolves.toMatchObject({
      authenticated: true,
    });
    await expect(requireRole("manage_users")).rejects.toBeInstanceOf(AuthorizationError);
  });
});

/**
 * Role → landing route (unified-platform-spec, Phase F).
 *
 * The spec gives each role its own dashboard. Resolving WHICH dashboard is kept here, as a pure
 * function over the role rank, precisely so that per-role routing is a table-driven unit test and
 * never needs a browser: the middleware that consumes it is a one-line wrapper.
 *
 * This is routing, NOT authorization. Landing somewhere is not permission to act there — every
 * page and every server action re-checks `requireRole` regardless of how the caller arrived.
 */
describe("role landing route", () => {
  it("gives every role in the rank a landing route", () => {
    for (const role of ROLES) {
      expect(ROLE_LANDING_ROUTE[role]).toMatch(/^\//);
    }
  });

  it("routes each role to its own dashboard", () => {
    expect(roleLandingRoute(["viewer"])).toBe(ROLE_LANDING_ROUTE.viewer);
    expect(roleLandingRoute(["pharmacist"])).toBe(ROLE_LANDING_ROUTE.pharmacist);
    expect(roleLandingRoute(["pharmacy_director"])).toBe(ROLE_LANDING_ROUTE.pharmacy_director);
    expect(roleLandingRoute(["admin"])).toBe(ROLE_LANDING_ROUTE.admin);
  });

  it("gives distinct routes to distinct roles", () => {
    const routes = ROLES.map((r) => ROLE_LANDING_ROUTE[r]);
    expect(new Set(routes).size).toBe(ROLES.length);
  });

  it("lands a multi-role user on their HIGHEST role's dashboard", () => {
    expect(roleLandingRoute(["viewer", "pharmacy_director"])).toBe(
      ROLE_LANDING_ROUTE.pharmacy_director,
    );
    expect(roleLandingRoute(["admin", "viewer", "pharmacist"])).toBe(ROLE_LANDING_ROUTE.admin);
  });

  it("is order-independent", () => {
    expect(roleLandingRoute(["admin", "viewer"])).toBe(roleLandingRoute(["viewer", "admin"]));
  });

  it("lands the anonymous demo visitor (no roles) on the viewer dashboard", () => {
    // STOPGAP_DEMO_MODE resolves a visitor to an anonymous viewer holding no role at all; the
    // public demo must still reach a real page rather than a redirect loop or a 404.
    expect(roleLandingRoute([])).toBe(ROLE_LANDING_ROUTE.viewer);
  });

  it("ignores unknown roles rather than throwing", () => {
    // Roles are unioned from IdP realm claims and local grants; an IdP can present a realm role
    // this build has never heard of. Routing must degrade, not 500 the sign-in redirect.
    expect(roleLandingRoute(["not_a_role" as Role])).toBe(ROLE_LANDING_ROUTE.viewer);
    expect(roleLandingRoute(["not_a_role" as Role, "pharmacist"])).toBe(
      ROLE_LANDING_ROUTE.pharmacist,
    );
  });

  it("never returns an external or protocol-relative destination", () => {
    // The route is fed to a redirect. A value that could leave the origin would make the
    // post-sign-in redirect an open redirect.
    for (const role of ROLES) {
      const route = ROLE_LANDING_ROUTE[role];
      expect(route.startsWith("/")).toBe(true);
      expect(route.startsWith("//")).toBe(false);
    }
  });
});

/**
 * Ticket 03 — which dashboard groups a caller may SEE.
 *
 * Visibility, never permission. Every assertion here is about what renders; what a caller may DO
 * is `assertRoleFor`, tested above, and reaching a route changes none of it.
 */
describe("canViewGroup", () => {
  it("admits a caller to their own group and to every group below it", () => {
    expect(DASHBOARD_GROUPS.every((g) => canViewGroup(["admin"], g))).toBe(true);
    expect(canViewGroup(["pharmacy_director"], "viewer")).toBe(true);
    expect(canViewGroup(["pharmacy_director"], "pharmacist")).toBe(true);
    expect(canViewGroup(["pharmacy_director"], "pharmacy_director")).toBe(true);
  });

  it("refuses a group above the caller's rank", () => {
    expect(canViewGroup(["viewer"], "pharmacist")).toBe(false);
    expect(canViewGroup(["pharmacist"], "pharmacy_director")).toBe(false);
    expect(canViewGroup(["pharmacy_director"], "admin")).toBe(false);
  });

  it("takes the HIGHEST role, like every other rule in this module", () => {
    expect(canViewGroup(["viewer", "pharmacy_director"], "pharmacist")).toBe(true);
  });

  it("lets the anonymous visitor reach the viewer surface, and nothing above it", () => {
    // The anonymous visitor is not a caller with NO roles: `resolvePrincipal` hands them the real
    // `viewer` role. That distinction is the whole of the next test.
    expect(canViewGroup(["viewer"], "viewer")).toBe(true);
    expect(canViewGroup(["viewer"], "pharmacist")).toBe(false);
  });

  it("refuses a caller with no recognized role, rather than treating them as a viewer", () => {
    // An empty or unknown-only role set is what a realm missing its Stopgap client mapper produces.
    // Admitting it to the viewer group would hand that tenant's data to anyone the IdP would
    // authenticate, so "no recognized role" is refused everywhere — including the lowest group.
    expect(canViewGroup([], "viewer")).toBe(false);
    expect(canViewGroup(["not_a_role"] as unknown as Role[], "viewer")).toBe(false);
    expect(hasRecognizedRole([])).toBe(false);
    expect(hasRecognizedRole(["not_a_role"] as unknown as Role[])).toBe(false);
    expect(hasRecognizedRole(["viewer"])).toBe(true);
  });

  it("skips a role this build does not know rather than throwing", () => {
    // An IdP may legitimately present a realm role a given deploy has never heard of; a throw here
    // would turn that into a failed sign-in rather than a harmless degrade to `viewer`.
    const roles = ["not_a_role", "pharmacist"] as unknown as Role[];
    expect(canViewGroup(roles, "pharmacist")).toBe(true);
    expect(canViewGroup(roles, "admin")).toBe(false);
  });

  /**
   * The property that makes the root redirect terminate.
   *
   * `/` sends a caller to `roleLandingRoute(roles)`; that route's group layout then asks
   * `canViewGroup`. If any role could be sent somewhere it may not see, the two would bounce the
   * request between them forever.
   */
  it("never sends a caller to a landing route their own roles cannot view", () => {
    for (const group of DASHBOARD_GROUPS) {
      const landing = roleLandingRoute([group]);
      const owner = DASHBOARD_GROUPS.find((g) => ROLE_LANDING_ROUTE[g] === landing);
      expect(owner).toBeDefined();
      expect(canViewGroup([group], owner!)).toBe(true);
    }
    // A caller with no recognized role is the one case with no landing route that would hold: every
    // group refuses them, so `/` and the group guard send them to `ACCESS_DENIED_ROUTE` instead.
    // That route is outside every group, which is what makes the redirect terminate.
    expect(hasRecognizedRole([])).toBe(false);
    expect(DASHBOARD_GROUPS.some((g) => ROLE_LANDING_ROUTE[g] === ACCESS_DENIED_ROUTE)).toBe(false);
  });
});
