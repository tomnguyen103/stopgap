import { addLlmSink } from "@stopgap/providers";
import { langfuseSink } from "./llm-span.js";
import { isTracingConfigured, startTracing } from "./tracing.js";

export { langfuseSink } from "./llm-span.js";
export {
  currentSpend,
  installSpendCap,
  resetSpendCap,
  spendCapStatus,
} from "./spend-cap.js";
export {
  flushTracing,
  isTracingConfigured,
  langfuseOtlpEndpoint,
  startTracing,
  stopTracing,
} from "./tracing.js";

/**
 * One call for a process that runs agents (worker, eval, scripts): start the exporter and
 * route the provider layer's telemetry into it. No-ops without Langfuse credentials, so the
 * same line is safe in every entrypoint. Returns true when tracing is actually live.
 */
export function initObservability(serviceName = "stopgap"): boolean {
  if (!isTracingConfigured()) return false;
  startTracing(serviceName);
  // Append, don't replace: the demo budget ledger installs its own sink for the same records.
  addLlmSink(langfuseSink());
  return true;
}
