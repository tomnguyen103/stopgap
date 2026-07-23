import { generateObject } from "ai";
import type { z } from "zod";
import { routeModel } from "./route.js";
import type { LlmCallRecord, LlmSink, ProviderName } from "./types.js";

let sink: LlmSink = () => {};

/** Install a telemetry sink (Phase 2 wires this to Langfuse/OTel). */
export function setLlmSink(next: LlmSink): void {
  sink = next;
}

function usdCost(
  inputTokens: number,
  outputTokens: number,
  usdPer1mInput: number,
  usdPer1mOutput: number,
): number {
  return (inputTokens / 1_000_000) * usdPer1mInput + (outputTokens / 1_000_000) * usdPer1mOutput;
}

export interface StructuredOptions<T extends z.ZodTypeAny> {
  schema: T;
  /** Human-readable label for telemetry (e.g. "assess-impact"). */
  operation: string;
  prompt: string;
  system?: string;
  provider?: ProviderName;
  /** Deterministic by default (temperature 0) — required for the offline eval gate. */
  temperature?: number;
  maxRetries?: number;
}

export interface StructuredResult<T> {
  object: T;
  meta: LlmCallRecord;
}

/**
 * Run a schema-validated structured generation through the routed provider, recording
 * cost/latency telemetry. All LLM judgment in Stopgap goes through this (ADR-0002).
 */
export async function generateStructured<T extends z.ZodTypeAny>(
  opts: StructuredOptions<T>,
): Promise<StructuredResult<z.infer<T>>> {
  const routed = await routeModel(opts.provider);
  const start = Date.now();
  let ok = false;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const result = await generateObject({
      model: routed.model,
      schema: opts.schema,
      prompt: opts.prompt,
      system: opts.system,
      temperature: opts.temperature ?? 0,
      maxRetries: opts.maxRetries ?? 2,
    });
    inputTokens = result.usage?.inputTokens ?? 0;
    outputTokens = result.usage?.outputTokens ?? 0;
    ok = true;
    const meta = buildMeta(routed, opts.operation, start, inputTokens, outputTokens, true);
    sink(meta);
    return { object: result.object, meta };
  } catch (err) {
    const meta = buildMeta(routed, opts.operation, start, inputTokens, outputTokens, ok);
    sink(meta);
    throw err;
  }
}

function buildMeta(
  routed: Awaited<ReturnType<typeof routeModel>>,
  operation: string,
  start: number,
  inputTokens: number,
  outputTokens: number,
  ok: boolean,
): LlmCallRecord {
  return {
    provider: routed.info.name,
    modelId: routed.info.modelId,
    operation,
    latencyMs: Date.now() - start,
    inputTokens,
    outputTokens,
    usdCost: usdCost(inputTokens, outputTokens, routed.info.usdPer1mInput, routed.info.usdPer1mOutput),
    ok,
    failedOver: routed.failedOver,
  };
}
