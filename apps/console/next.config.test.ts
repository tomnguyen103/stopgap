import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "./next.config";

const originalIssuer = process.env.KEYCLOAK_ISSUER;

afterEach(() => {
  if (originalIssuer === undefined) delete process.env.KEYCLOAK_ISSUER;
  else process.env.KEYCLOAK_ISSUER = originalIssuer;
});

describe("console CSP", () => {
  it("allows the default Keycloak origin for the sign-in form", async () => {
    delete process.env.KEYCLOAK_ISSUER;

    const headers = await nextConfig.headers!();
    const csp = headers[0]?.headers.find((header) => header.key === "Content-Security-Policy");

    expect(csp?.value).toContain("form-action 'self' http://localhost:8080");
  });

  it("allows the configured public Keycloak origin for the production sign-in form", async () => {
    process.env.KEYCLOAK_ISSUER = "https://sso.example.test/realms/stopgap";

    const headers = await nextConfig.headers!();
    const csp = headers[0]?.headers.find((header) => header.key === "Content-Security-Policy");

    expect(csp?.value).toContain("form-action 'self' https://sso.example.test");
    expect(csp?.value).not.toContain("http://localhost:8080");
  });
});
