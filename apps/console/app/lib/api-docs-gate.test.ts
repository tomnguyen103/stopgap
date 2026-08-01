import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ mode: "unconfigured" as "demo" | "auth" | "unconfigured" }));
const resolvePrincipal = vi.fn();

vi.mock("@stopgap/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stopgap/core")>();
  return {
    ...actual,
    getEnv: () =>
      state.mode === "demo"
        ? { STOPGAP_DEMO_MODE: "on" }
        : state.mode === "auth"
          ? {
              STOPGAP_DEMO_MODE: "off",
              AUTH_SECRET: "test-auth-secret",
              KEYCLOAK_CLIENT_SECRET: "test-client-secret",
            }
          : { STOPGAP_DEMO_MODE: "off" },
  };
});

vi.mock("./principal", () => ({ resolvePrincipal: () => resolvePrincipal() }));

const { docsAudienceAllowed } = await import("./api-docs-gate");

describe("API documentation audience gate", () => {
  it("allows the explicitly enabled public demo", async () => {
    state.mode = "demo";
    expect(await docsAudienceAllowed()).toBe(true);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it("refuses an unconfigured non-demo deployment", async () => {
    state.mode = "unconfigured";
    expect(await docsAudienceAllowed()).toBe(false);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it("requires an authenticated console session when auth is configured", async () => {
    state.mode = "auth";
    resolvePrincipal.mockResolvedValue({ authenticated: false });
    expect(await docsAudienceAllowed()).toBe(false);
    resolvePrincipal.mockResolvedValue({ authenticated: true });
    expect(await docsAudienceAllowed()).toBe(true);
  });
});
