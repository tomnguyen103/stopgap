import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { LlmCallRecord, LlmSink } from "@stopgap/providers";

/**
 * OTel GenAI semantic-convention attribute names. Spelled out here rather than imported from
 * `@opentelemetry/semantic-conventions/incubating` — the GenAI group is still incubating, so
 * its exported symbol names churn between minor releases while the wire attribute names
 * (what Langfuse and every other backend actually key on) are stable.
 */
const GEN_AI = {
  operationName: "gen_ai.operation.name",
  system: "gen_ai.system",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
} as const;

/**
 * Stopgap-specific attributes. `stopgap.failed_over` is the one that matters operationally:
 * it makes "how often did Gemini fall back to local Ollama, and what did that cost in
 * latency" a dashboard query instead of a log grep.
 */
const STOPGAP = {
  failedOver: "stopgap.failed_over",
  usdCost: "stopgap.usd_cost",
} as const;

/** Langfuse renders spans carrying this attribute as generations (token/cost view). */
const LANGFUSE_OBSERVATION_TYPE = "langfuse.observation.type";

/**
 * Emit one OTel GenAI span per structured LLM call.
 *
 * The span is recorded after the fact from the provider layer's `LlmCallRecord` and
 * backdated by its measured latency, so `generateStructured` stays free of tracing code and
 * an unconfigured environment carries no instrumentation cost at all (see ADR-0002: all LLM
 * judgment flows through one function, so one sink covers every call site).
 */
export function langfuseSink(): LlmSink {
  const tracer = trace.getTracer("@stopgap/observability");
  return (record: LlmCallRecord) => {
    const end = Date.now();
    const span = tracer.startSpan(`gen_ai ${record.operation}`, {
      startTime: end - record.latencyMs,
      attributes: {
        [GEN_AI.operationName]: record.operation,
        [GEN_AI.system]: record.provider,
        [GEN_AI.requestModel]: record.modelId,
        [GEN_AI.responseModel]: record.modelId,
        [GEN_AI.inputTokens]: record.inputTokens,
        [GEN_AI.outputTokens]: record.outputTokens,
        [STOPGAP.failedOver]: record.failedOver,
        [STOPGAP.usdCost]: record.usdCost,
        [LANGFUSE_OBSERVATION_TYPE]: "generation",
      },
    });
    if (!record.ok) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${record.operation} failed` });
    }
    span.end(end);
  };
}
