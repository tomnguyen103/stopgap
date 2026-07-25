import { collectMetricsText } from "@stopgap/observability/metrics";

/**
 * Prometheus metrics for the console (PHASE6 §6.4). DB-derived gauges only — the event-driven
 * counters (comms, task failures) belong to the worker process and are exposed on its sidecar, so
 * `includeCounters` is false here. Node runtime + a direct DB read rendered to Prometheus text with
 * no heavy exporter lib, deliberately imported from the `@stopgap/observability/metrics` subpath so
 * the OTel tracing deps never enter this route's bundle.
 *
 * UNAUTHENTICATED, and that constrains what may be emitted here (PHASE6 §6.5). The route is
 * exempted in middleware so Prometheus can scrape it, which means anyone who can reach the console
 * can read it — including any one tenant's users. So it exposes only DEPLOYMENT-WIDE aggregate
 * counts: no organization names, no per-tenant series, never secrets or PHI. Per-org gauges were
 * built and then removed for exactly this reason — labelled by slug they would have let any visitor
 * enumerate every hospital on the deployment and read each one's case volume and exception backlog.
 * Serving per-org series needs an authenticated scrape; see the open question under §6.5 in
 * PHASE6-PLAN.md and the header of `packages/observability/src/metrics.ts`.
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
