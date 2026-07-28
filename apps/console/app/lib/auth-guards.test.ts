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
      manage_users: false,
      manage_api_keys: false,
    },
    pharmacist: {
      review_case: true,
      resolve_exception: true,
      approve_protocol_version: false,
      manage_users: false,
      manage_api_keys: false,
    },
    pharmacy_director: {
      review_case: true,
      resolve_exception: true,
      approve_protocol_version: true,
      manage_users: false,
      manage_api_keys: false,
    },
    admin: {
      review_case: true,
      resolve_exception: true,
      approve_protocol_version: true,
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
    await expect(requireRole("approve_protocol_version")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("REFUSES a pharmacist managing users", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(requireRole("manage_users")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("lets a pharmacy_director approve a protocol version", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    await expect(requireRole("approve_protocol_version")).resolves.toMatchObject({ authenticated: true });
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
    await expect(requireRole("approve_protocol_version")).resolves.toMatchObject({ authenticated: true });
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
    expect(roleLandingRoute(["viewer", "pharmacy_director"])).toBe(ROLE_LANDING_ROUTE.pharmacy_director);
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
    expect(roleLandingRoute(["not_a_role" as Role, "pharmacist"])).toBe(ROLE_LANDING_ROUTE.pharmacist);
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
