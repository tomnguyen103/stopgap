import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getEnv } from "@stopgap/core/env";
import { createOllama } from "ollama-ai-provider-v2";
import type { ProviderInfo, ProviderName, ResolvedModel } from "./types.js";

/**
 * Provider registry. Builds AI SDK LanguageModels for each provider and exposes their
 * cost/stub metadata. Gemini 3.7 Flash pricing per Google's published rates (2026-08):
 * promotional through 2026-12-31, standard from 2027-01-01 (UTC boundary). Ollama is
 * local and therefore free.
 */
const GEMINI_PROMO_ENDS_MS = Date.UTC(2027, 0, 1);
const GEMINI_PROMO_USD = { input: 0.75, output: 3.75 };
const GEMINI_STANDARD_USD = { input: 1.5, output: 7.5 };

/** Gemini 3.7 Flash rates for the given instant — promotional until 2027-01-01 UTC. */
export function geminiPricing(now: Date = new Date()): {
  usdPer1mInput: number;
  usdPer1mOutput: number;
} {
  const rates = now.getTime() < GEMINI_PROMO_ENDS_MS ? GEMINI_PROMO_USD : GEMINI_STANDARD_USD;
  return { usdPer1mInput: rates.input, usdPer1mOutput: rates.output };
}

export function geminiInfo(now: Date = new Date()): ProviderInfo {
  const env = getEnv();
  return {
    name: "gemini",
    modelId: env.GEMINI_MODEL,
    ...geminiPricing(now),
    stub: !env.GEMINI_API_KEY,
  };
}

export function ollamaInfo(): ProviderInfo {
  const env = getEnv();
  return {
    name: "ollama",
    modelId: env.OLLAMA_MODEL,
    usdPer1mInput: 0,
    usdPer1mOutput: 0,
    stub: false,
  };
}

export function providerInfo(name: ProviderName): ProviderInfo {
  return name === "gemini" ? geminiInfo() : ollamaInfo();
}

/** Build a concrete model + its metadata. Throws if the provider is stubbed. */
export function resolveModel(name: ProviderName): ResolvedModel {
  const env = getEnv();
  if (name === "gemini") {
    const info = geminiInfo();
    if (info.stub) throw new Error("gemini provider is stubbed (no GEMINI_API_KEY)");
    const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
    return { info, model: google(info.modelId) };
  }
  const info = ollamaInfo();
  const ollama = createOllama({ baseURL: `${env.OLLAMA_BASE_URL}/api` });
  return { info, model: ollama(info.modelId) };
}
