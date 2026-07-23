import { fileURLToPath } from "node:url";
import type { ShortageRecord } from "@stopgap/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as activities from "./activities.js";
import type { CaseInput } from "./shared.js";
import {
  pollFeedsWorkflow,
  resolvedSignal,
  reviewSignal,
  shortageCaseWorkflow,
  stateQuery,
} from "./workflows.js";

/**
 * Time-skipped durability test (PROJECT_PLAN §3C): proves a case blocks for weeks on a
 * pharmacist signal and feed resolution, then resumes and closes — all in milliseconds of
 * wall-clock via Temporal's time-skipping test server. Activities are mocked here (no DB).
 */

const TASK_QUEUE = "test-cases";

function heparin(): ShortageRecord {
  return {
    source: "openfda",
    sourceId: "0338-0431-03:Current",
    key: "heparin sodium",
    genericName: "Heparin Sodium Injection",
    status: "current",
    ndcs: ["0338-0431-03", "0338-0433-04"],
    rxcuis: ["1658690"],
  };
}

/** Deterministic in-memory activity stubs — mirror the real signatures, no side effects. */
const mockActivities: typeof activities = {
  recordDetected: async () => {},
  persistStatus: async () => {},
  assessImpact: async (input: CaseInput) => ({
    severity: input.record.ndcs.length >= 2 ? "high" : "moderate",
    affectedFormularyItems: input.record.ndcs.length,
    rationale: "test",
    confidence: /low impact confidence/i.test(input.record.genericName) ? 0.2 : 0.9,
  }),
  researchAlternatives: async (input: CaseInput) =>
    /immune globulin/i.test(input.record.genericName)
      ? { alternatives: [], draft: "", confidence: 0.9 }
      : /low alt confidence/i.test(input.record.genericName)
        ? { alternatives: ["alt-a"], draft: "draft protocol", confidence: 0.2 }
        : { alternatives: ["alt-a", "alt-b"], draft: "draft protocol", confidence: 0.9 },
  sendComms: async () => {},
  recordDecision: async () => {},
  pollAndOpenCases: async () => ({ polled: 0, opened: 0 }),
};

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: mockActivities,
  });
  return worker.runUntil(fn());
}

describe("shortageCaseWorkflow (time-skipped)", () => {
  it("resumes a multi-week case: approve → monitor weeks → resolve → close", async () => {
    await withWorker(async () => {
      const input: CaseInput = { record: heparin(), sources: ["openfda"] };
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [input],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-${Date.now()}`,
      });

      // The case reaches the HITL gate and blocks there.
      await env.sleep("1 hour");
      expect((await handle.query(stateQuery)).status).toBe("awaiting_review");

      // Pharmacist approves; case moves into long-horizon monitoring.
      await handle.signal(reviewSignal, { kind: "approve" });
      await env.sleep("1 hour");
      expect((await handle.query(stateQuery)).status).toBe("monitoring");

      // Six weeks pass with no resolution (fast-forwarded), then the feed resolves it.
      await env.sleep("42 days");
      const midMonitoring = await handle.query(stateQuery);
      expect(midMonitoring.status).toBe("monitoring");
      expect(midMonitoring.monitoringWeeks).toBe(6);
      await handle.signal(resolvedSignal);

      const final = await handle.result();
      expect(final.status).toBe("closed");
      expect(final.decision).toEqual({ kind: "approve" });
    });
  }, 60_000);

  it("routes a no-equivalent drug straight to the exception queue", async () => {
    await withWorker(async () => {
      const record = { ...heparin(), genericName: "Immune Globulin", key: "immune globulin" };
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record, sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-exc-${Date.now()}`,
      });
      const final = await handle.result();
      expect(final.status).toBe("exception");
    });
  }, 60_000);

  it("routes low-confidence alternatives to the exception queue instead of auto-drafting", async () => {
    await withWorker(async () => {
      const record = { ...heparin(), genericName: "Low Alt Confidence Drug", key: "low alt confidence drug" };
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record, sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-lowconf-${Date.now()}`,
      });
      const final = await handle.result();
      expect(final.status).toBe("exception");
    });
  }, 60_000);

  it("routes low-confidence impact assessment to exception without spending a research call", async () => {
    await withWorker(async () => {
      const record = { ...heparin(), genericName: "Low Impact Confidence Drug", key: "low impact confidence drug" };
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record, sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-lowimpactconf-${Date.now()}`,
      });
      const final = await handle.result();
      expect(final.status).toBe("exception");
      expect(final.alternatives).toEqual([]);
    });
  }, 60_000);

  it("auto-escalates to exception when a case is never resolved (90-day timeout)", async () => {
    await withWorker(async () => {
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: heparin(), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-timeout-${Date.now()}`,
      });
      await env.sleep("1 hour");
      await handle.signal(reviewSignal, { kind: "approve" });
      // Let 91 days elapse with no resolution signal → monitoring timeout.
      const final = await handle.result();
      expect(final.status).toBe("exception");
    });
  }, 60_000);
});

describe("pollFeedsWorkflow (time-skipped)", () => {
  it("delegates to the pollAndOpenCases activity and returns its result", async () => {
    await withWorker(async () => {
      const handle = await env.client.workflow.start(pollFeedsWorkflow, {
        args: [],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-poll-${Date.now()}`,
      });
      expect(await handle.result()).toEqual({ polled: 0, opened: 0 });
    });
  }, 60_000);
});
