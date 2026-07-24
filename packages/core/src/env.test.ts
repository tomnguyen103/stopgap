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
