import { collectMetricsText } from "@stopgap/observability/metrics";

/**
 * Prometheus metrics for the console (PHASE6 §6.4). DB-derived gauges only — the event-driven
 * counters (comms, task failures) belong to the worker process and are exposed on its sidecar, so
 * `includeCounters` is false here. Node runtime + a direct DB read rendered to Prometheus text with
 * no heavy exporter lib, deliberately imported from the `@stopgap/observability/metrics` subpath so
 * the OTel tracing deps never enter this route's bundle. Unauthenticated (exempted in middleware)
 * so Prometheus can scrape it; it exposes only aggregate counts, never secrets or PHI.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const body = await collectMetricsText(false);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4" },
  });
}
