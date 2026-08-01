import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@stopgap/core";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ default: vi.fn() }));

const { default: middleware } = await import("./middleware");

const originalDemoMode = process.env.STOPGAP_DEMO_MODE;
const originalAuthSecret = process.env.AUTH_SECRET;
const originalClientSecret = process.env.KEYCLOAK_CLIENT_SECRET;

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.STOPGAP_DEMO_MODE;
  else process.env.STOPGAP_DEMO_MODE = originalDemoMode;
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
  if (originalClientSecret === undefined) delete process.env.KEYCLOAK_CLIENT_SECRET;
  else process.env.KEYCLOAK_CLIENT_SECRET = originalClientSecret;
  resetEnvCache();
});

function request(): NextRequest {
  return new NextRequest("http://console.test/");
}

describe("console route protection", () => {
  it("fails closed when demo mode is off and the IdP is not configured", async () => {
    process.env.STOPGAP_DEMO_MODE = "off";
    delete process.env.AUTH_SECRET;
    delete process.env.KEYCLOAK_CLIENT_SECRET;
    resetEnvCache();

    const response = await middleware(request(), {} as never);
    if (!response) throw new Error("middleware returned no response");

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "authentication_not_configured" });
  });

  it("keeps the explicitly enabled public demo anonymous", async () => {
    process.env.STOPGAP_DEMO_MODE = "on";
    delete process.env.AUTH_SECRET;
    delete process.env.KEYCLOAK_CLIENT_SECRET;
    resetEnvCache();

    const response = await middleware(request(), {} as never);
    if (!response) throw new Error("middleware returned no response");

    expect(response.status).toBe(200);
  });
});
