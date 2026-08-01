import { afterEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "./env.js";

describe("LLM_DAILY_USD_CAP parsing", () => {
  const original = process.env.LLM_DAILY_USD_CAP;

  afterEach(() => {
    if (original === undefined) delete process.env.LLM_DAILY_USD_CAP;
    else process.env.LLM_DAILY_USD_CAP = original;
    resetEnvCache();
  });

  it("treats an empty string as no cap, not a $0 cap", () => {
    // The bug this guards: z.coerce.number() turns "" into 0, and a $0 cap routes every call
    // to the local model — the opposite of "no cap". `LLM_DAILY_USD_CAP=` must mean unset.
    process.env.LLM_DAILY_USD_CAP = "";
    resetEnvCache();
    expect(getEnv().LLM_DAILY_USD_CAP).toBeUndefined();
  });

  it("treats an unset value as no cap", () => {
    delete process.env.LLM_DAILY_USD_CAP;
    resetEnvCache();
    expect(getEnv().LLM_DAILY_USD_CAP).toBeUndefined();
  });

  it("parses a configured number", () => {
    process.env.LLM_DAILY_USD_CAP = "5";
    resetEnvCache();
    expect(getEnv().LLM_DAILY_USD_CAP).toBe(5);
  });

  it("keeps an explicit 0 as a real $0 cap", () => {
    process.env.LLM_DAILY_USD_CAP = "0";
    resetEnvCache();
    expect(getEnv().LLM_DAILY_USD_CAP).toBe(0);
  });
});

describe("WORKER_HTTP_PORT bounds", () => {
  const original = process.env.WORKER_HTTP_PORT;

  afterEach(() => {
    if (original === undefined) delete process.env.WORKER_HTTP_PORT;
    else process.env.WORKER_HTTP_PORT = original;
    resetEnvCache();
  });

  it("accepts the highest bindable port", () => {
    process.env.WORKER_HTTP_PORT = "65535";
    resetEnvCache();
    expect(getEnv().WORKER_HTTP_PORT).toBe(65535);
  });

  it("rejects a port above the TCP range", () => {
    // Without .max(65535) this parses fine and the worker only dies later, at bind time.
    process.env.WORKER_HTTP_PORT = "65536";
    resetEnvCache();
    expect(() => getEnv()).toThrow();
  });
});

describe("OIDC issuer validation", () => {
  const original = process.env.KEYCLOAK_ISSUER;

  afterEach(() => {
    if (original === undefined) delete process.env.KEYCLOAK_ISSUER;
    else process.env.KEYCLOAK_ISSUER = original;
    resetEnvCache();
  });

  it("rejects a malformed issuer before Auth.js can fail during sign-in", () => {
    process.env.KEYCLOAK_ISSUER = "not-a-url";
    resetEnvCache();
    expect(() => getEnv()).toThrow();
  });
});
