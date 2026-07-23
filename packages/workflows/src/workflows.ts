import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import {
  MAX_MONITORING_MS,
  MONITOR_POLL_MS,
  type CaseInput,
  type CaseState,
  type ReviewDecision,
} from "./shared.js";

/**
 * The durable spine of Stopgap (ADR-0002, PROJECT_PLAN §3C). One workflow per shortage
 * case; it owns every status transition, survives worker restarts and deploys, and blocks
 * for weeks on a pharmacist signal or feed resolution. LLM judgment lives only in activities.
 */

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1s", backoffCoefficient: 2 },
});

/** Pharmacist approve/edit/reject on the drafted protocol. */
export const reviewSignal = defineSignal<[ReviewDecision]>("review");
/** Feed marked the shortage resolved → begin reversion. */
export const resolvedSignal = defineSignal("resolved");
/** Queryable case snapshot (drives the console + tests). */
export const stateQuery = defineQuery<CaseState>("state");

export async function shortageCaseWorkflow(input: CaseInput): Promise<CaseState> {
  const key = input.record.key;
  const state: CaseState = {
    status: "detected",
    alternatives: [],
    monitoringWeeks: 0,
    resolved: false,
  };
  setHandler(stateQuery, () => state);

  let decision: ReviewDecision | undefined;
  setHandler(reviewSignal, (d) => {
    decision = d;
  });
  setHandler(resolvedSignal, () => {
    state.resolved = true;
  });

  await acts.recordDetected(input);

  // Assess impact.
  state.status = "assessing";
  await acts.persistStatus(key, "assessing");
  const impact = await acts.assessImpact(input);
  state.severity = impact.severity;

  // Research alternatives.
  state.status = "researching";
  await acts.persistStatus(key, "researching", { severity: impact.severity });
  const research = await acts.researchAlternatives(input);
  state.alternatives = research.alternatives;
  state.draft = research.draft;

  // No therapeutic equivalent → exception queue (always human; PROJECT_PLAN §2 exception matrix).
  if (research.alternatives.length === 0) {
    state.status = "exception";
    await acts.persistStatus(key, "exception", { reason: "no-therapeutic-equivalent" });
    return state;
  }

  // Draft ready → HITL gate.
  state.status = "protocol_draft";
  await acts.persistStatus(key, "protocol_draft");
  state.status = "awaiting_review";
  await acts.persistStatus(key, "awaiting_review");

  // Block (possibly for days) until the pharmacist decides.
  await condition(() => decision !== undefined);
  state.decision = decision;
  await acts.recordDecision(key, decision!);
  if (decision!.kind === "reject") {
    state.status = "rejected";
    await acts.persistStatus(key, "rejected", { reason: decision!.reason });
    return state;
  }
  if (decision!.kind === "edit") state.draft = decision!.editedDraft;

  // Approved → comms out.
  state.status = "approved";
  await acts.persistStatus(key, "approved");
  await acts.sendComms(key, state.draft ?? "");
  state.status = "comms_sent";
  await acts.persistStatus(key, "comms_sent");

  // Monitor until the feed resolves the shortage — the long-horizon leg (weeks–months).
  // Ticks weekly (durable across worker restarts/deploys) so monitoringWeeks reflects real
  // elapsed time; auto-escalates to exception if unresolved past MAX_MONITORING_MS total.
  state.status = "monitoring";
  await acts.persistStatus(key, "monitoring");
  const monitorStart = Date.now();
  while (!state.resolved) {
    const remaining = MAX_MONITORING_MS - (Date.now() - monitorStart);
    if (remaining <= 0) break;
    const resolvedInTime = await condition(() => state.resolved, Math.min(MONITOR_POLL_MS, remaining));
    if (resolvedInTime) break;
    state.monitoringWeeks += 1;
    await acts.persistStatus(key, "monitoring", { monitoringWeeks: state.monitoringWeeks });
  }
  const deadlineHit = !state.resolved;
  if (deadlineHit) {
    state.status = "exception";
    await acts.persistStatus(key, "exception", { reason: "monitoring-timeout" });
    return state;
  }

  // Resolved → draft reversion, then close.
  state.status = "reverting";
  await acts.persistStatus(key, "reverting");
  state.status = "closed";
  await acts.persistStatus(key, "closed");
  return state;
}

/**
 * The feed-poll workflow (PROJECT_PLAN §4: "poll → new shortage auto-opens a case"). One
 * run = one poll of openFDA + ASHP; a Temporal Schedule (`scripts/start-schedule.ts`) fires
 * it on a cadence so new shortages open cases without a human running `start-case` by hand.
 */
export async function pollFeedsWorkflow(): Promise<{ polled: number; opened: number }> {
  return acts.pollAndOpenCases();
}
