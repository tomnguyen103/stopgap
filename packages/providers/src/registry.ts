import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getEnv } from "@stopgap/core/env";
import { createOllama } from "ollama-ai-provider-v2";
import type { ProviderInfo, ProviderName, ResolvedModel } from "./types.js";

/**
 * Provider registry. Builds AI SDK LanguageModels for each provider and exposes their
 * cost/stub metadata. Gemini 3.5 Flash Lite pricing per Google's published rates
 * (2026-07); Ollama is local and therefore free.
 */
const GEMINI_USD_PER_1M_INPUT = 0.1;
const GEMINI_USD_PER_1M_OUTPUT = 0.4;

export function geminiInfo(): ProviderInfo {
  const env = getEnv();
  return {
    name: "gemini",
    modelId: env.GEMINI_MODEL,
    usdPer1mInput: GEMINI_USD_PER_1M_INPUT,
    usdPer1mOutput: GEMINI_USD_PER_1M_OUTPUT,
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
