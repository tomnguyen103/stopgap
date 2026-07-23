import type { LanguageModel } from "ai";

export type ProviderName = "gemini" | "ollama";

export interface ProviderInfo {
  name: ProviderName;
  /** The concrete model id (e.g. "gemini-3.5-flash-lite" or "mistral"). */
  modelId: string;
  /** USD per 1M input / output tokens. Ollama (local) is 0. */
  usdPer1mInput: number;
  usdPer1mOutput: number;
  /** True when the provider is not usable (e.g. Gemini with no API key). */
  stub: boolean;
}

export interface ResolvedModel {
  info: ProviderInfo;
  model: LanguageModel;
}

/** One structured LLM call's telemetry, emitted to the configured sink. */
export interface LlmCallRecord {
  provider: ProviderName;
  modelId: string;
  operation: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number;
  ok: boolean;
  /** True if this call ran on the failover provider rather than the requested one. */
  failedOver: boolean;
}

export type LlmSink = (record: LlmCallRecord) => void;
