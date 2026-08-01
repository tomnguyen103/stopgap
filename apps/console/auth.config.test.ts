import { describe, expect, it } from "vitest";
import { authConfig } from "./auth.config";

describe("console authentication provider", () => {
  it("keeps the Auth.js sign-in page self-contained", () => {
    const provider = authConfig.providers[0] as { style?: { logo?: string } };

    expect(provider.style?.logo).toBe("");
  });
});
