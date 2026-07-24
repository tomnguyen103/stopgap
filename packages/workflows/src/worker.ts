import { fileURLToPath } from "node:url";
import { getEnv } from "@stopgap/core/env";
import { installDemoBudget } from "@stopgap/demo";
import { flushTracing, initObservability } from "@stopgap/observability";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

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
  installDemoBudget();
  console.log(`[worker] daily LLM budget cap: $${env.DEMO_DAILY_USD_CAP.toFixed(2)}`);
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
  await flushTracing().catch(() => {});
}

main().catch(async (err) => {
  console.error("[worker] fatal:", err);
  await flushTracing().catch(() => {});
  process.exit(1);
});
