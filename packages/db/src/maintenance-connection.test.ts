import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE MAINTENANCE CONNECTION AS A READINESS CONDITION (PHASE6 §6.5).
 *
 * When `DATABASE_URL_MAINTENANCE` is unset, `withBypassDb` falls back to the ordinary pool. On the
 * zero-config local stack that is correct — `DATABASE_URL` names the compose superuser, which
 * bypasses every policy anyway — and gating on it would 503 the dev stack for no reason.
 *
 * In production, where `DATABASE_URL` correctly names a NON-bypassing application role, the same
 * fallback is a deployment that looks healthy and serves nobody: `rlsEnforced` reports true (the
 * policies really are applying) while every cross-tenant read returns zero rows, so OIDC sign-in
 * cannot resolve a subject to an org and REST key authentication cannot resolve a key hash. The
 * console comes up, passes every other probe, and nobody can log in.
 *
 * These tests pin that asymmetry, with no live database: the pool is faked so what is under test is
 * the DECISION, which is the part a misconfigured deployment depends on.
 */

interface FakeRole {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

let env: { DATABASE_URL: string; DATABASE_URL_MAINTENANCE?: string; NODE_ENV: string };
/** What `pg_roles` answers for each pool, keyed by the url the pool was opened with. */
let rolesByUrl: Map<string, FakeRole>;

vi.mock("@stopgap/core/env", () => ({ getEnv: () => env }));

vi.mock("postgres", () => ({
  default: (url: string) => ({ __url: url, end: async () => undefined }),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (client: { __url: string }) => ({
    execute: async () => {
      const role = rolesByUrl.get(client.__url);
      return role ? [role] : [];
    },
  }),
}));

const { checkMaintenanceConnection, closeDb } = await import("./client.js");

const APP_URL = "postgres://app@db/stopgap";
const MAINT_URL = "postgres://maintenance@db/stopgap";

const APP_ROLE: FakeRole = { rolname: "stopgap_app", rolsuper: false, rolbypassrls: false };
const MAINT_ROLE: FakeRole = { rolname: "stopgap_maintenance", rolsuper: false, rolbypassrls: true };
const SUPERUSER: FakeRole = { rolname: "stopgap", rolsuper: true, rolbypassrls: false };

beforeEach(() => {
  rolesByUrl = new Map();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  // The probes describe a CONNECTION, so they are memoised per pool; closing resets them.
  await closeDb();
  vi.restoreAllMocks();
});

describe("checkMaintenanceConnection", () => {
  it("FAILS READINESS in production when DATABASE_URL_MAINTENANCE is unset", async () => {
    env = { DATABASE_URL: APP_URL, NODE_ENV: "production" };
    rolesByUrl.set(APP_URL, APP_ROLE);

    const status = await checkMaintenanceConnection();

    expect(status.ok).toBe(false);
    expect(status.required).toBe(true);
    expect(status.configured).toBe(false);
    // The reason names the variable, because that is the whole fix.
    expect(status.reason).toContain("DATABASE_URL_MAINTENANCE");
    // Loud at startup, not only when a probe asks.
    expect(console.error).toHaveBeenCalled();
  });

  it("FAILS READINESS in production when the maintenance role does not bypass RLS", async () => {
    // Configured, reachable, and still useless: a second pool pointed at the application role
    // bypasses nothing, so every cross-tenant read returns zero rows exactly as if it were unset.
    env = { DATABASE_URL: APP_URL, DATABASE_URL_MAINTENANCE: MAINT_URL, NODE_ENV: "production" };
    rolesByUrl.set(APP_URL, APP_ROLE);
    rolesByUrl.set(MAINT_URL, APP_ROLE);

    const status = await checkMaintenanceConnection();

    expect(status.ok).toBe(false);
    expect(status.configured).toBe(true);
    expect(status.reason).toContain("BYPASSRLS");
  });

  it("PASSES in production with a BYPASSRLS maintenance role", async () => {
    env = { DATABASE_URL: APP_URL, DATABASE_URL_MAINTENANCE: MAINT_URL, NODE_ENV: "production" };
    rolesByUrl.set(APP_URL, APP_ROLE);
    rolesByUrl.set(MAINT_URL, MAINT_ROLE);

    const status = await checkMaintenanceConnection();

    expect(status.ok).toBe(true);
    expect(status.reason).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does NOT gate development, where the single-role stack legitimately has no second pool", async () => {
    // The zero-config local shape: one superuser connection, no maintenance url. 503-ing this would
    // only teach operators to ignore the check.
    env = { DATABASE_URL: APP_URL, NODE_ENV: "development" };
    rolesByUrl.set(APP_URL, SUPERUSER);

    const status = await checkMaintenanceConnection();

    expect(status.ok).toBe(true);
    expect(status.required).toBe(false);
    expect(status.configured).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports the state honestly in development even when the connection is unusable", async () => {
    // Not a failure here, but not silently reported as fine either: `reason` is present so the
    // readiness payload says what the deployment would hit once NODE_ENV is production.
    env = { DATABASE_URL: APP_URL, NODE_ENV: "development" };
    rolesByUrl.set(APP_URL, APP_ROLE);

    const status = await checkMaintenanceConnection();

    expect(status.ok).toBe(true);
    expect(status.reason).toContain("DATABASE_URL_MAINTENANCE");
  });
});
