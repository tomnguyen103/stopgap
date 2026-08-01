import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ demoMode: "off" as "on" | "off", authConfigured: false }));

vi.mock("@stopgap/core", () => ({
  getEnv: () => ({ STOPGAP_DEMO_MODE: state.demoMode }),
  authConfigured: () => state.authConfigured,
}));

vi.mock("@stopgap/db", () => ({
  checkAppRoleRls: vi.fn(async () => ({ checked: true, bypassesRls: false })),
  checkMaintenanceConnection: vi.fn(async () => ({
    ok: true,
    configured: true,
    required: true,
  })),
  pingDb: vi.fn(async () => true),
}));

vi.mock("@stopgap/workflows", () => ({ checkTemporal: vi.fn(async () => true) }));

const { GET } = await import("./route");

describe("console readiness authentication check", () => {
  it("keeps explicit demo mode ready without auth credentials", async () => {
    state.demoMode = "on";
    state.authConfigured = false;

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ready: true,
      checks: { authentication: { ok: true, configured: false, required: false, demoMode: true } },
    });
  });

  it("fails readiness when non-demo auth is not configured", async () => {
    state.demoMode = "off";
    state.authConfigured = false;

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ready: false,
      checks: { authentication: { ok: false, configured: false, required: true, demoMode: false } },
    });
  });

  it("reports a configured non-demo deployment ready", async () => {
    state.demoMode = "off";
    state.authConfigured = true;

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ready: true,
      checks: { authentication: { ok: true, configured: true, required: true, demoMode: false } },
    });
  });
});
