import { resetEnvCache } from "@stopgap/core/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiInfo, ollamaInfo } from "./registry.js";
import { routeModel } from "./route.js";

describe("provider info", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
  });

  it("marks gemini stub when no API key, ollama never stub and free", () => {
    expect(geminiInfo().stub).toBe(true);
    const o = ollamaInfo();
    expect(o.stub).toBe(false);
    expect(o.usdPer1mInput).toBe(0);
    expect(o.usdPer1mOutput).toBe(0);
  });
});

describe("routeModel failover", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
  });

  it("fails over from stubbed gemini to healthy ollama", async () => {
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    const routed = await routeModel("gemini");
    expect(routed.info.name).toBe("ollama");
    expect(routed.failedOver).toBe(true);
    expect(routed.requested).toBe("gemini");
  });

  it("throws when no provider is usable", async () => {
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    await expect(routeModel("ollama")).rejects.toThrow(/no usable LLM provider/);
  });
});
