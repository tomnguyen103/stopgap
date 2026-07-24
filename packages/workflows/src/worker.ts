import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { getEnv } from "@stopgap/core/env";
import { pingDb } from "@stopgap/db";
import { collectMetricsText, flushTracing, initObservability, installSpendCap } from "@stopgap/observability";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { checkTemporal } from "./client.js";

/**
 * The worker's HTTP sidecar (PHASE6 §6.4). The worker has no web surface, so this tiny server is
 * how Prometheus scrapes it (`/metrics`, gauges + the worker's own event counters) and how compose
 * health-checks it: `/healthz` is pure liveness (the process is up), `/readyz` is honest readiness
 * — it actually reaches Postgres (`select 1`) and Temporal (cluster info) and returns 503 naming
 * the dependency that is down, so "the worker is up but can't work" is a distinct, visible state.
 * Unauthenticated by design (Prometheus scrapes it), and it exposes only counts, never secrets.
 */
function startHttpSidecar(port: number): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    void (async () => {
      try {
        if (path === "/healthz") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (path === "/readyz") {
          const [dbOk, temporalOk] = await Promise.all([pingDb(), checkTemporal()]);
          const ready = dbOk && temporalOk;
          res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ready, checks: { database: dbOk, temporal: temporalOk } }));
          return;
        }
        if (path === "/metrics") {
          const body = await collectMetricsText(true);
          res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
          res.end(body);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });
  server.listen(port, () => {
    console.log(`[worker] http sidecar on :${String(port)} (/healthz /readyz /metrics)`);
  });
  return server;
}

/**
 * The case worker: hosts the workflow code + activities on the task queue. Run via
 * `pnpm worker`. Survives restarts — in-flight cases resume from their last durable state.
 */
async function main() {
  const env = getEnv();
  // Activities (not workflows) make the LLM calls, so tracing lives on the worker process.
  console.log(`[worker] Langfuse tracing ${initObservability("stopgap-worker") ? "enabled" : "disabled (no Langfuse keys)"}`);
  // Spend accounting + daily cap. The worker is where the LLM calls happen, so this is where
  // they have to be counted — a cap enforced only in the console would miss every scheduled poll.
  const capped = installSpendCap();
  console.log(
    `[worker] daily LLM spend cap: ${capped ? `$${String(env.LLM_DAILY_USD_CAP)}` : "none (LLM_DAILY_USD_CAP unset)"}`,
  );
  // Start the health/metrics sidecar before the worker loop so a scrape or health check works the
  // moment the process is up, even while the worker is still connecting to Temporal.
  const sidecar = startHttpSidecar(env.WORKER_HTTP_PORT);
  const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
  });
  console.log(`[worker] listening on task queue "${env.TEMPORAL_TASK_QUEUE}" @ ${env.TEMPORAL_ADDRESS}`);
  await worker.run();
  // Reached on a normal shutdown (SIGTERM/SIGINT, which Worker.run handles): whatever is
  // still in the batch span buffer would otherwise be dropped on exit.
  sidecar.close();
  await flushTracing().catch(() => {});
}

main().catch(async (err) => {
  console.error("[worker] fatal:", err);
  await flushTracing().catch(() => {});
  process.exit(1);
});
