import { fileURLToPath } from "node:url";
import { getEnv } from "@stopgap/core/env";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

/**
 * The case worker: hosts the workflow code + activities on the task queue. Run via
 * `pnpm worker`. Survives restarts — in-flight cases resume from their last durable state.
 */
async function main() {
  const env = getEnv();
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
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
