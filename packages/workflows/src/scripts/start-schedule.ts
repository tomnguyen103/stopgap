import { getEnv } from "@stopgap/core/env";
import { ScheduleAlreadyRunning } from "@temporalio/client";
import { makeClient } from "../client.js";
import { pollFeedsWorkflow } from "../workflows.js";

const SCHEDULE_ID = "poll-feeds";

/**
 * Create (or confirm) the Temporal Schedule that drives the auto-open spine
 * (PROJECT_PLAN §4: "poll → new shortage auto-opens a case"). Idempotent — safe to re-run.
 *
 *   pnpm --filter @stopgap/workflows start-schedule
 */
async function main() {
  const env = getEnv();
  const { client, connection } = await makeClient();
  try {
    await client.schedule.create({
      scheduleId: SCHEDULE_ID,
      spec: { intervals: [{ every: "15m" }] },
      action: {
        type: "startWorkflow",
        workflowType: pollFeedsWorkflow,
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        workflowId: "poll-feeds-run",
      },
      policies: { overlap: "SKIP" },
    });
    console.log(`[start-schedule] created schedule "${SCHEDULE_ID}" (every 15m)`);
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) {
      console.log(`[start-schedule] schedule "${SCHEDULE_ID}" already exists`);
    } else {
      throw err;
    }
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error("[start-schedule] failed:", err);
  process.exit(1);
});
