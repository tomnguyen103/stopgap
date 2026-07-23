import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { getEnv } from "@stopgap/core/env";

/**
 * OTel tracer provider pointed at self-hosted Langfuse (PROJECT_PLAN §9). Langfuse ingests
 * OpenTelemetry natively at `/api/public/otel/v1/traces` with HTTP Basic auth over the
 * project's public/secret key pair, so Stopgap emits vendor-neutral OTel GenAI spans rather
 * than Langfuse-SDK-shaped events — swapping Langfuse for any other OTLP backend is then a
 * URL change, not a code change.
 */

let provider: NodeTracerProvider | undefined;

/** Langfuse's OTLP trace endpoint for the configured base URL. */
export function langfuseOtlpEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
}

/**
 * True when Langfuse credentials are configured. Without them tracing stays off entirely
 * (no exporter, no background flush timer) — the local gate and offline evals must run with
 * zero configuration.
 */
export function isTracingConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

/**
 * Start the exporter. Idempotent: repeated calls return the existing provider so a worker
 * that initialises tracing per module doesn't stack duplicate exporters.
 */
export function startTracing(serviceName = "stopgap"): NodeTracerProvider | undefined {
  if (provider) return provider;
  if (!isTracingConfigured()) return undefined;
  const env = getEnv();
  const credentials = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const exporter = new OTLPTraceExporter({
    url: langfuseOtlpEndpoint(env.LANGFUSE_BASE_URL),
    headers: { Authorization: `Basic ${credentials}` },
  });
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: "0.1.0",
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return provider;
}

/** Flush pending spans (call before a short-lived process exits, or spans are lost). */
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush();
}

/** Shut the exporter down and allow a later `startTracing` to build a fresh one. */
export async function stopTracing(): Promise<void> {
  const current = provider;
  provider = undefined;
  await current?.shutdown();
}
