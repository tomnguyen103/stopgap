import { resetEnvCache } from "@stopgap/core/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBudgetGuard, setBudgetGuard } from "./budget.js";
import { geminiInfo, ollamaInfo } from "./registry.js";
import { routeModel } from "./route.js";

describe("provider info", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
  });

  afterEach(() => {
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
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
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
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

  it("stays on the requested provider when the budget guard reports headroom", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    resetEnvCache();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    setBudgetGuard(() => ({ spentUsd: 0.5, capUsd: 2, overCap: false }));
    try {
      const routed = await routeModel("gemini");
      expect(routed.info.name).toBe("gemini");
      expect(routed.budgetCapped).toBe(false);
    } finally {
      clearBudgetGuard();
    }
  });

  it("forces the free local provider once the daily cap is spent", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    resetEnvCache();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    setBudgetGuard(() => ({ spentUsd: 2.5, capUsd: 2, overCap: true }));
    try {
      const routed = await routeModel("gemini");
      expect(routed.info.name).toBe("ollama");
      expect(routed.budgetCapped).toBe(true);
    } finally {
      clearBudgetGuard();
    }
  });

  it("treats a failing budget guard as under cap rather than silently downgrading", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    resetEnvCache();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    setBudgetGuard(() => {
      throw new Error("spend table unreachable");
    });
    try {
      const routed = await routeModel("gemini");
      expect(routed.info.name).toBe("gemini");
      expect(routed.budgetCapped).toBe(false);
    } finally {
      clearBudgetGuard();
    }
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
