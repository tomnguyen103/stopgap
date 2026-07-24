/**
 * Manual verification: run one real agent call with tracing on and confirm the span lands in
 * self-hosted Langfuse. Not part of the gate (needs docker + Ollama + Langfuse keys).
 *
 *   docker compose --profile langfuse up -d
 *   LANGFUSE_PUBLIC_KEY=pk-lf-stopgap-local LANGFUSE_SECRET_KEY=sk-lf-stopgap-local \
 *     pnpm --filter @stopgap/observability verify:trace
 */
import { assessImpact } from "@stopgap/agents";
import { flushTracing, initObservability, stopTracing } from "../src/index.js";

const enabled = initObservability("stopgap-verify-trace");
console.log("[verify-trace] tracing enabled:", enabled);
if (!enabled) {
  console.error("[verify-trace] set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY first");
  process.exit(1);
}

try {
  const impact = await assessImpact({
    source: "openfda",
    sourceId: "verify-trace-1",
    key: "heparin sodium",
    genericName: "Heparin Sodium Injection",
    status: "current",
    ndcs: ["0338-0431-03", "0338-0433-04"],
    rxcuis: ["1658690"],
    note: "Manufacturing delay, no restock date.",
  });
  console.log("[verify-trace] impact:", impact.severity, "confidence:", impact.confidence);
} finally {
  // In `finally` because a failed call still produces a span worth exporting — that failure
  // is exactly what the trace is meant to show.
  await flushTracing();
  await stopTracing();
  console.log("[verify-trace] spans flushed to Langfuse");
}
