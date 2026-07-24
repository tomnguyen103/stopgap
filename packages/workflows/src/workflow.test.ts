import { fileURLToPath } from "node:url";
import type { ShortageRecord } from "@stopgap/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as activities from "./activities.js";
import type { CaseInput, RecordProtocolInput } from "./shared.js";
import {
  acknowledgeSignal,
  anchorAuditWorkflow,
  exceptionResolvedSignal,
  pollFeedsWorkflow,
  resolvedSignal,
  reviewSignal,
  shortageCaseWorkflow,
  stateQuery,
} from "./workflows.js";
import type { OpenMonitoringCase } from "@stopgap/db";
import { diffResolutions } from "./feed-resolution.js";

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

/** Escalation notifications the workflow fired, asserted by the escalation tests. */
const escalationNotifications: {
  key: string;
  severity: string;
  stepIndex: number;
  notify: string;
  afterMinutes: number;
  delivered: boolean;
}[] = [];
/** Acknowledgments the workflow recorded, asserted by the escalation tests. */
const recordedAcks: { key: string; userId: string; label: string; step: number }[] = [];

/** Deterministic in-memory activity stubs — mirror the real signatures, no side effects. */
const mockActivities: typeof activities = {
  recordDetected: async () => {},
  persistStatus: async () => {},
  assessImpact: async (input: CaseInput) => {
    // Simulates the provider being down long enough to exhaust the activity's retries.
    if (/provider outage/i.test(input.record.genericName)) {
      throw new Error("no usable LLM provider (requested ollama); checked ollama, gemini");
    }
    return {
      // A name saying "critical" forces the critical ladder; otherwise 2+ NDCs → high (heparin).
      severity: /critical/i.test(input.record.genericName)
        ? ("critical" as const)
        : input.record.ndcs.length >= 2
          ? ("high" as const)
          : ("moderate" as const),
      affectedFormularyItems: input.record.ndcs.length,
      rationale: "test",
      confidence: /low impact confidence/i.test(input.record.genericName) ? 0.2 : 0.9,
    };
  },
  researchAlternatives: async (input: CaseInput) =>
    /immune globulin/i.test(input.record.genericName)
      ? { alternatives: [], draft: "", confidence: 0.9 }
      : /low alt confidence/i.test(input.record.genericName)
        ? { alternatives: ["alt-a"], draft: "draft protocol", confidence: 0.2 }
        : { alternatives: ["alt-a", "alt-b"], draft: "draft protocol", confidence: 0.9 },
  sendComms: async () => ({ delivered: true }),
  recordDecision: async () => {},
  pollAndOpenCases: async () => ({ polled: 0, opened: 0, resolved: 0 }),
  anchorAuditChain: async () => ({ maxAuditId: 7, headHash: "deadbeef", sink: "file" }),
  // Memory hit only for the drug whose name says so, so every other case exercises the
  // agent-research path exactly as before.
  lookupProtocol: async (key: string) =>
    /remembered/i.test(key)
      ? { versionId: "v-1", version: 3, body: "remembered protocol", alternatives: ["alt-remembered"] }
      : undefined,
  recordProtocolVersion: async (input) => {
    recordedProtocols.push(input);
  },
  getEscalationPolicy: async (severity: string) =>
    severity === "critical"
      ? {
          severity,
          steps: [
            { afterMinutes: 0, notify: "pharmacist" },
            { afterMinutes: 30, notify: "pharmacy_director" },
            { afterMinutes: 60, notify: "admin" },
          ],
        }
      : severity === "high"
        ? {
            severity,
            steps: [
              { afterMinutes: 0, notify: "pharmacist" },
              { afterMinutes: 120, notify: "pharmacy_director" },
            ],
          }
        : null,
  sendEscalationNotification: async (input) => {
    // A key saying "nondeliver" models a channel that is down: non-delivery is recorded and the
    // ladder STILL advances (the workflow never branches on `delivered`).
    const delivered = !/nondeliver/i.test(input.key);
    escalationNotifications.push({ ...input, delivered });
    return { delivered };
  },
  recordAck: async (input) => {
    // A key saying "ackfails" models durable ack persistence that never succeeds — the activity
    // rejects on every attempt, so the workflow sees a terminal failure after its retries.
    if (/ackfails/i.test(input.key)) throw new Error("acknowledgments table unreachable");
    recordedAcks.push(input);
  },
};

/** Protocol write-backs the workflow performed, asserted by the memory tests. */
const recordedProtocols: RecordProtocolInput[] = [];

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

  it("parks a case in the exception queue when the agent layer is down, instead of dropping it", async () => {
    await withWorker(async () => {
      const record = { ...heparin(), genericName: "Provider Outage Drug", key: "provider outage drug" };
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record, sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-outage-${Date.now()}`,
      });
      // The workflow must survive the failure: a thrown activity would fail the run and
      // leave the case frozen mid-assessment with nobody told (PROJECT_PLAN §14: 0 dropped).
      const final = await handle.result();
      expect(final.status).toBe("exception");
      expect(final.exceptionReason).toBe("agent-unavailable");
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

describe("organizational memory (time-skipped)", () => {
  it("reuses an approved protocol instead of researching, and writes no duplicate version", async () => {
    await withWorker(async () => {
      const before = recordedProtocols.length;
      const record = { ...heparin(), genericName: "Remembered Drug", key: "remembered drug" };
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record, sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-mem-${Date.now()}`,
      });
      await env.sleep("1 hour");
      const parked = await handle.query(stateQuery);
      expect(parked.status).toBe("awaiting_review");
      expect(parked.protocolSource).toBe("memory");
      expect(parked.protocolVersion).toBe(3);
      expect(parked.draft).toBe("remembered protocol");

      await handle.signal(reviewSignal, { kind: "approve" });
      await env.sleep("1 hour");
      await handle.signal(resolvedSignal);
      expect((await handle.result()).status).toBe("closed");
      // Approving remembered text unchanged adds nothing new to remember.
      expect(recordedProtocols.length).toBe(before);
    });
  }, 60_000);

  it("writes an approved agent draft back into the protocol store", async () => {
    await withWorker(async () => {
      const before = recordedProtocols.length;
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: heparin(), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-writeback-${Date.now()}`,
      });
      await env.sleep("1 hour");
      await handle.signal(reviewSignal, {
        kind: "edit",
        editedDraft: "pharmacist text",
        reviewer: "pharmacist-1",
      });
      await env.sleep("1 hour");
      await handle.signal(resolvedSignal);
      await handle.result();

      const written = recordedProtocols.slice(before);
      expect(written).toHaveLength(1);
      expect(written[0]?.body).toBe("pharmacist text");
      // The claimed reviewer identity, not a hardcoded "pharmacist" the audit couldn't back up.
      expect(written[0]?.authoredBy).toBe("pharmacist-1");
      expect(written[0]?.approvedBy).toBe("pharmacist-1");
    });
  }, 60_000);

  it("lets a pharmacist resolve an exception case: the resolution becomes a rule and the case continues", async () => {
    await withWorker(async () => {
      const before = recordedProtocols.length;
      const record = { ...heparin(), genericName: "Immune Globulin", key: "immune globulin" };
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record, sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-excloop-${Date.now()}`,
      });
      await env.sleep("1 hour");
      const parked = await handle.query(stateQuery);
      expect(parked.status).toBe("exception");
      expect(parked.exceptionReason).toBe("no-therapeutic-equivalent");

      await handle.signal(exceptionResolvedSignal, {
        protocolBody: "Allocate remaining stock to immunodeficiency patients; no substitution.",
        alternatives: ["conserve-and-allocate"],
        resolvedBy: "pharmacist-1",
        rationale: "No therapeutic equivalent; allocation policy applies.",
      });
      await env.sleep("1 hour");
      // The pharmacist's own text needs no second approval — the case goes straight on.
      expect((await handle.query(stateQuery)).status).toBe("monitoring");
      await handle.signal(resolvedSignal);
      const final = await handle.result();
      expect(final.status).toBe("closed");
      expect(final.protocolSource).toBe("exception-resolution");

      const written = recordedProtocols.slice(before);
      expect(written).toHaveLength(1);
      expect(written[0]?.approvedBy).toBe("pharmacist-1");
      expect(written[0]?.rationale).toContain("No therapeutic equivalent");
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
      expect(await handle.result()).toEqual({ polled: 0, opened: 0, resolved: 0 });
    });
  }, 60_000);
});

describe("anchorAuditWorkflow (time-skipped)", () => {
  it("delegates to the anchorAuditChain activity and returns its result", async () => {
    await withWorker(async () => {
      const handle = await env.client.workflow.start(anchorAuditWorkflow, {
        args: [],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-anchor-${Date.now()}`,
      });
      expect(await handle.result()).toEqual({ maxAuditId: 7, headHash: "deadbeef", sink: "file" });
    });
  }, 60_000);
});

describe("escalation ladder (time-skipped)", () => {
  /** A critical case reaches the HITL gate and blocks there, with the ladder running concurrently. */
  function criticalRecord(key: string): ShortageRecord {
    return { ...heparin(), genericName: `Critical ${key}`, key };
  }

  it("ignores an acknowledgment for a case whose ladder never started", async () => {
    await withWorker(async () => {
      // Moderate severity (single NDC, no "critical" in the name): no ladder, so nobody has been
      // paged. An ack accepted here would mark the case acknowledged for a page that never
      // happened — and on a case that later escalates, would let it skip the ladder entirely.
      const key = "moderate-preack";
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: { ...heparin(), genericName: `Moderate ${key}`, key, ndcs: ["1"] }, sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-esc-preack-${Date.now()}`,
      });
      await env.sleep("5 minutes");
      await handle.signal(acknowledgeSignal, { userId: "user-9", label: "pharmacist-9" });
      await env.sleep("5 minutes");
      const st = await handle.query(stateQuery);
      expect(st.acked).toBe(false);
      expect(st.ackedBy).toBeUndefined();
      expect(recordedAcks.filter((a) => a.key === key)).toHaveLength(0);
    });
  }, 60_000);

  it("resumes the ladder when an acknowledgment cannot be persisted", async () => {
    await withWorker(async () => {
      // An ack the DB never accepts must not quietly bury the remaining tiers: the case is not
      // acknowledged (no row, no audit entry), so the director and admin still have to be paged.
      const key = "critical-ackfails";
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: criticalRecord(key), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-esc-ackfails-${Date.now()}`,
      });
      await env.sleep("1 minute");
      expect((await handle.query(stateQuery)).escalationStep).toBe(0);
      await handle.signal(acknowledgeSignal, { userId: "user-7", label: "pharmacist-7" });
      await env.sleep("90 minutes");

      const st = await handle.query(stateQuery);
      expect(st.acked).toBe(false);
      expect(st.ackedBy).toBeUndefined();
      expect(st.ackError).toBeDefined();
      // The ladder resumed rather than dying on the rolled-back flag.
      expect(st.escalationStep).toBe(2);
      expect(escalationNotifications.filter((n) => n.key === key).map((f) => f.stepIndex)).toEqual([0, 1, 2]);
      expect(recordedAcks.filter((a) => a.key === key)).toHaveLength(0);
    });
  }, 60_000);

  it("escalates through every tier when no one acknowledges", async () => {
    await withWorker(async () => {
      const key = "critical-noack";
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: criticalRecord(key), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-esc-noack-${Date.now()}`,
      });
      // Past the 60-minute final tier with no ack: the ladder climbs all three tiers while the case
      // sits blocked on pharmacist review.
      await env.sleep("90 minutes");
      const st = await handle.query(stateQuery);
      expect(st.status).toBe("awaiting_review");
      expect(st.escalationStep).toBe(2);
      expect(st.escalatedAt).toHaveLength(3);
      expect(st.acked).toBe(false);

      const fired = escalationNotifications.filter((n) => n.key === key);
      expect(fired.map((f) => f.stepIndex)).toEqual([0, 1, 2]);
      expect(fired.map((f) => f.notify)).toEqual(["pharmacist", "pharmacy_director", "admin"]);
      expect(fired.every((f) => f.severity === "critical")).toBe(true);
    });
  }, 60_000);

  it("stops the ladder the moment a human acknowledges", async () => {
    await withWorker(async () => {
      const key = "critical-ack";
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: criticalRecord(key), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-esc-ack-${Date.now()}`,
      });
      // Tier 0 fires immediately; ack before tier 1 (30 min) would fire.
      await env.sleep("1 minute");
      expect((await handle.query(stateQuery)).escalationStep).toBe(0);
      await handle.signal(acknowledgeSignal, { userId: "user-1", label: "pharmacist-1" });
      // Long past every remaining tier: none of them may fire now.
      await env.sleep("90 minutes");
      const st = await handle.query(stateQuery);
      expect(st.acked).toBe(true);
      expect(st.ackedBy).toBe("user-1");
      expect(st.escalationStep).toBe(0);

      expect(escalationNotifications.filter((n) => n.key === key)).toHaveLength(1);
      // The ack landed with the authenticated user id (the real code appends it to the audit chain).
      const acks = recordedAcks.filter((a) => a.key === key);
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({ userId: "user-1", label: "pharmacist-1", step: 0 });
    });
  }, 60_000);

  it("keeps the escalating case and its pending tier timer durable after the worker stops", async () => {
    // The durability guarantee the ladder rests on: the escalation timer is a Temporal SERVER-SIDE
    // timer, so the case and its pending next-tier fire survive the death of the worker that armed
    // them — an in-process `setTimeout` would be lost the moment the worker exits.
    //
    // This is asserted WITHOUT a literal worker recreate: on the current @temporalio/core (1.21) a
    // second Worker on the same task queue cannot resume a mid-execution workflow under the
    // time-skipping test server — verified to hang even for a plain non-escalating case — so a true
    // "start a fresh worker and watch it resume" cannot be exercised here. Instead we prove the two
    // halves the harness DOES support: (a) below, the execution + its pending tier-1 timer persist
    // after the worker stops; and (b) the "escalates through every tier" test above, where the
    // ladder climbs across a 90-minute skip — which only a durable Temporal timer (never an
    // in-process one) responds to. Together they are the survive-a-restart guarantee.
    const key = "critical-durable";
    const workflowId = `wf-esc-durable-${Date.now()}`;
    await withWorker(async () => {
      await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: criticalRecord(key), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      // Tier 0 has fired; tier 1's durable timer (30 min out) is armed and pending.
      await env.sleep("2 minutes");
      expect((await env.client.workflow.getHandle(workflowId).query(stateQuery)).escalationStep).toBe(0);
    });
    // Worker is gone. The execution — and the pending tier-1 timer — live on the server, so the
    // case is still RUNNING, not failed or dropped.
    const handle = env.client.workflow.getHandle(workflowId);
    const desc = await handle.describe();
    expect(desc.status.name).toBe("RUNNING");
    expect(escalationNotifications.filter((n) => n.key === key).map((f) => f.stepIndex)).toEqual([0]);
    // Terminate so this case's still-PENDING tier-1 timer is not left for the next test's worker to
    // fire — resuming a mid-execution workflow under a fresh worker is the very thing the current
    // core cannot do under the time-skip server, and it would hang the following test.
    await handle.terminate();
  }, 60_000);

  it("records non-delivery yet still advances the ladder through every tier", async () => {
    await withWorker(async () => {
      const key = "critical-nondeliver";
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: criticalRecord(key), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-esc-nd-${Date.now()}`,
      });
      // Every tier's send is a non-delivery (dead channel), but the ladder must not stall on it —
      // the existing comms stance: a failed page is recorded, never a reason to freeze escalation.
      await env.sleep("90 minutes");
      const st = await handle.query(stateQuery);
      expect(st.escalationStep).toBe(2);
      const fired = escalationNotifications.filter((n) => n.key === key);
      expect(fired.map((f) => f.stepIndex)).toEqual([0, 1, 2]);
      expect(fired.every((f) => f.delivered === false)).toBe(true);
    });
  }, 60_000);

  it("persists a late ack that arrives AFTER the ladder has escalated through every tier", async () => {
    await withWorker(async () => {
      const key = "critical-lateack";
      const handle = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: criticalRecord(key), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId: `wf-esc-late-${Date.now()}`,
      });
      // Ladder exhausts all three tiers with no ack.
      await env.sleep("90 minutes");
      let st = await handle.query(stateQuery);
      expect(st.escalationStep).toBe(2);
      expect(st.acked).toBe(false);

      // The human acks LATE — after full escalation. The durable recorder (which outlives the
      // ladder) must still write the acknowledgment row + audit entry with the user id; the ladder
      // loop alone would have missed it, leaving the case counted critical-unacked forever.
      await handle.signal(acknowledgeSignal, { userId: "user-3", label: "director-2" });
      await env.sleep("1 minute");
      st = await handle.query(stateQuery);
      expect(st.acked).toBe(true);
      expect(st.ackedBy).toBe("user-3");

      const acks = recordedAcks.filter((a) => a.key === key);
      expect(acks).toHaveLength(1);
      // Step defaults to the final tier reached (2), so the unique(case,step) constraint does not
      // silently drop it. The real recordAck activity writes the row + `case.acknowledged` audit
      // entry with this user id (asserted here via the captured activity args).
      expect(acks[0]).toMatchObject({ userId: "user-3", label: "director-2", step: 2 });
    });
  }, 60_000);
});

describe("feed-resolution auto-detect (time-skipped)", () => {
  /**
   * Drives a real case into monitoring, then simulates the poller: each "poll" runs the real
   * `diffResolutions` against an in-memory case whose miss counter accrues, and signals the
   * workflow's `resolvedSignal` exactly when the diff says to. This ties the pure counting to
   * the actual workflow signal without a database — the case must stay monitoring while the
   * key is absent for fewer than N polls, and close once absence reaches N.
   */
  async function driveToMonitoring(workflowId: string) {
    const handle = await env.client.workflow.start(shortageCaseWorkflow, {
      args: [{ record: heparin(), sources: ["openfda"] }],
      taskQueue: TASK_QUEUE,
      workflowId,
    });
    await env.sleep("1 hour");
    await handle.signal(reviewSignal, { kind: "approve" });
    await env.sleep("1 hour");
    expect((await handle.query(stateQuery)).status).toBe("monitoring");
    return handle;
  }

  it("resolves a case after N consecutive absent polls, not before", async () => {
    await withWorker(async () => {
      const handle = await driveToMonitoring(`wf-resolve-${Date.now()}`);
      const threshold = 3;
      const inMemory: OpenMonitoringCase = {
        caseId: "c",
        key: heparin().key,
        source: "openfda",
        sourceId: heparin().sourceId,
        feedMissCount: 0,
      };
      const emptyFeed = { currentKeys: new Set<string>(), resolvedKeys: new Set<string>() };

      // Two absent polls: still monitoring (single/double flap must not resolve).
      for (let poll = 1; poll < threshold; poll += 1) {
        const diff = diffResolutions([inMemory], emptyFeed, threshold, new Date().toISOString());
        expect(diff.toResolve).toHaveLength(0);
        inMemory.feedMissCount += diff.toBump.length;
        await env.sleep("1 hour");
        expect((await handle.query(stateQuery)).status).toBe("monitoring");
      }

      // Nth absent poll: the diff says resolve → signal the workflow.
      const finalDiff = diffResolutions([inMemory], emptyFeed, threshold, new Date().toISOString());
      expect(finalDiff.toResolve).toHaveLength(1);
      await handle.signal(resolvedSignal);
      expect((await handle.result()).status).toBe("closed");
    });
  }, 60_000);

  it("keeps a case monitoring while its key stays current (no false resolution)", async () => {
    await withWorker(async () => {
      const handle = await driveToMonitoring(`wf-stay-${Date.now()}`);
      const present = { currentKeys: new Set([heparin().key]), resolvedKeys: new Set<string>() };
      for (let poll = 0; poll < 5; poll += 1) {
        const diff = diffResolutions(
          [{ caseId: "c", key: heparin().key, source: "openfda", sourceId: "x", feedMissCount: 0 }],
          present,
          3,
          new Date().toISOString(),
        );
        expect(diff.toResolve).toHaveLength(0);
        await env.sleep("1 hour");
      }
      expect((await handle.query(stateQuery)).status).toBe("monitoring");
    });
  }, 60_000);

  it("reopens a fresh run against the same case after the key reappears (recurrence path)", async () => {
    await withWorker(async () => {
      // A recurring shortage reuses ONE workflow id (workflowIdForKey), so this stands in for
      // the case row. First run: absence resolves it and it closes.
      const workflowId = `wf-recurrence-${Date.now()}`;
      const first = await driveToMonitoring(workflowId);
      const threshold = 3;
      const inMemory: OpenMonitoringCase = {
        caseId: "c",
        key: heparin().key,
        source: "openfda",
        sourceId: heparin().sourceId,
        feedMissCount: 0,
      };
      const emptyFeed = { currentKeys: new Set<string>(), resolvedKeys: new Set<string>() };
      for (let poll = 1; poll <= threshold; poll += 1) {
        const diff = diffResolutions([inMemory], emptyFeed, threshold, new Date().toISOString());
        if (diff.toResolve.length > 0) await first.signal(resolvedSignal);
        else inMemory.feedMissCount += diff.toBump.length;
        await env.sleep("1 hour");
      }
      expect((await first.result()).status).toBe("closed");

      // Key reappears as current → the poll's startCase reopens against the SAME workflow id
      // (ALLOW_DUPLICATE reuse policy, allowed now the previous run is terminal). This is the
      // existing Phase 3 recurrence path — a new RUN, same case row, not a new path. Asserting
      // a fresh run started (a new run id on the same workflow id) is the reopen proof; the new
      // run's own lifecycle is covered by the other cases in this file.
      const second = await env.client.workflow.start(shortageCaseWorkflow, {
        args: [{ record: heparin(), sources: ["openfda"] }],
        taskQueue: TASK_QUEUE,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
      expect(second.firstExecutionRunId).not.toBe(first.firstExecutionRunId);
    });
  }, 60_000);
});
