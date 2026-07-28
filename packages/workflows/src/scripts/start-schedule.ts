import { getEnv } from "@stopgap/core/env";
import { Client, ScheduleAlreadyRunning } from "@temporalio/client";
import { makeClient } from "../client.js";
import { ANCHOR_AUDIT_WORKFLOW, DAILY_BRIEF_WORKFLOW, POLL_FEEDS_WORKFLOW } from "../shared.js";

const POLL_SCHEDULE_ID = "poll-feeds";
const ANCHOR_SCHEDULE_ID = "anchor-audit";
const BRIEF_SCHEDULE_ID = "daily-brief";
import { ANCHOR_AUDIT_WORKFLOW, POLL_FEEDS_WORKFLOW, RETENTION_SWEEP_WORKFLOW } from "../shared.js";

const POLL_SCHEDULE_ID = "poll-feeds";
const ANCHOR_SCHEDULE_ID = "anchor-audit";
const RETENTION_SCHEDULE_ID = "retention-sweep";

/** Create one schedule, treating "already exists" as success (idempotent re-run). */
async function ensureSchedule(
  client: Client,
  opts: { scheduleId: string; every: string; workflowType: string; workflowId: string; taskQueue: string },
): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: opts.scheduleId,
      spec: { intervals: [{ every: opts.every }] },
      action: {
        type: "startWorkflow",
        workflowType: opts.workflowType,
        taskQueue: opts.taskQueue,
        workflowId: opts.workflowId,
      },
      // SKIP overlap: a slow run must not stack a second one on top of itself.
      policies: { overlap: "SKIP" },
    });
    console.log(`[start-schedule] created schedule "${opts.scheduleId}" (every ${opts.every})`);
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) {
      console.log(`[start-schedule] schedule "${opts.scheduleId}" already exists`);
    } else {
      throw err;
    }
  }
}

/**
 * Create (or confirm) the Temporal Schedules that run without a human:
 *   - poll-feeds (15m): the auto-open spine (PROJECT_PLAN §4).
 *   - anchor-audit (1h): the external audit-chain anchor (PHASE6 §6.2).
 *   - daily-brief (24h): the per-tenant daily brief (ticket 13).
 *   - retention-sweep (24h): removes records past their retention window (ticket 18). Daily
 *     rather than hourly because the windows are measured in months — an hourly sweep would spend
 *     twenty-four scans a day to find what one finds.
 * Idempotent — safe to re-run.
 *
 *   pnpm --filter @stopgap/workflows start-schedule
 */
async function main() {
  const env = getEnv();
  const { client, connection } = await makeClient();
  try {
    await ensureSchedule(client, {
      scheduleId: POLL_SCHEDULE_ID,
      every: "15m",
      workflowType: POLL_FEEDS_WORKFLOW,
      workflowId: "poll-feeds-run",
      taskQueue: env.TEMPORAL_TASK_QUEUE,
    });
    await ensureSchedule(client, {
      scheduleId: ANCHOR_SCHEDULE_ID,
      every: "1h",
      workflowType: ANCHOR_AUDIT_WORKFLOW,
      workflowId: "anchor-audit-run",
      taskQueue: env.TEMPORAL_TASK_QUEUE,
    });
    await ensureSchedule(client, {
      scheduleId: BRIEF_SCHEDULE_ID,
      every: "24h",
      workflowType: DAILY_BRIEF_WORKFLOW,
      workflowId: "daily-brief-run",
      scheduleId: RETENTION_SCHEDULE_ID,
      every: "24h",
      workflowType: RETENTION_SWEEP_WORKFLOW,
      workflowId: "retention-sweep-run",
      taskQueue: env.TEMPORAL_TASK_QUEUE,
    });
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error("[start-schedule] failed:", err);
  process.exit(1);
});
