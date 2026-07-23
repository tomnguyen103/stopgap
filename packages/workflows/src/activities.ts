import type { CaseStatus, Severity } from "@stopgap/core";
import {
  appendAudit,
  getCaseByWorkflowId,
  getDb,
  updateCaseStatus,
  upsertCaseForRecord,
  workflowIdForKey,
} from "@stopgap/db";
import { mergeRecords, pollAshp, pollOpenFda } from "@stopgap/ingest";
import { makeClient, startCase } from "./client.js";
import type { CaseInput, ImpactResult, ResearchResult, ReviewDecision } from "./shared.js";

/**
 * Activities are the only place workflows touch the outside world (DB, feeds, LLMs). In
 * Phase 1 the judgment activities (`assessImpact`, `researchAlternatives`) are deterministic
 * mocks; Phase 2 replaces their bodies with the Vercel AI SDK agents. The DB-side effects
 * are real. Every activity is idempotent so Temporal retries are safe.
 */

/** Persist a newly detected case and open the audit chain. Idempotent (upsert). */
export async function recordDetected(input: CaseInput): Promise<void> {
  const db = getDb();
  const row = await upsertCaseForRecord(db, input.record);
  await appendAudit(db, {
    caseId: row.id,
    actor: "system",
    action: "case.detected",
    detail: { key: input.record.key, sources: input.sources },
  });
}

/** Mirror the workflow's status transition to Postgres + audit log. */
export async function persistStatus(
  key: string,
  status: CaseStatus,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  const workflowId = workflowIdForKey(key);
  const row = await getCaseByWorkflowId(db, workflowId);
  await updateCaseStatus(db, workflowId, status, {
    severity: detail.severity as Severity | undefined,
    lastNote: detail.note as string | undefined,
    closedAt: status === "closed" ? new Date() : undefined,
  });
  await appendAudit(db, {
    caseId: row?.id,
    actor: (detail.actor as string) ?? "system",
    action: `case.${status}`,
    detail,
  });
}

/**
 * Mock impact assessment (Phase 2 → AI SDK agent). Deterministic severity from the number
 * of affected NDCs so tests and the offline eval gate are reproducible.
 */
export async function assessImpact(input: CaseInput): Promise<ImpactResult> {
  const n = input.record.ndcs.length;
  const severity: Severity = n === 0 ? "low" : n >= 4 ? "critical" : n >= 2 ? "high" : "moderate";
  return {
    severity,
    affectedFormularyItems: n,
    rationale: `Deterministic Phase-1 assessment: ${n} affected NDC(s) → ${severity}.`,
  };
}

/**
 * Mock alternatives research (Phase 2 → AI SDK agent + RxNorm). Returns a canned substitute
 * unless the drug is flagged no-equivalent, which drives the exception path.
 */
export async function researchAlternatives(input: CaseInput): Promise<ResearchResult> {
  const name = input.record.genericName;
  // A couple of well-known no-equivalent drugs route to the human exception queue.
  const noEquivalent = /(immune globulin|compounded|iron sucrose)/i.test(name);
  if (noEquivalent) return { alternatives: [], draft: "" };
  return {
    alternatives: [`${name} (alternate manufacturer)`, "therapeutic-class substitute (see protocol)"],
    draft: `Substitution protocol for ${name}: prefer alternate-manufacturer supply; if unavailable, use a same-class agent with pharmacist dose verification. [Phase-1 draft]`,
  };
}

/** Mock outbound comms (Phase 4 → Resend + EHR webhook). Records the intent in the audit log. */
export async function sendComms(key: string, draft: string): Promise<void> {
  const db = getDb();
  const workflowId = workflowIdForKey(key);
  const row = await getCaseByWorkflowId(db, workflowId);
  await appendAudit(db, {
    caseId: row?.id,
    actor: "system",
    action: "comms.sent",
    detail: { channel: "mock", chars: draft.length },
  });
}

/** Record a HITL decision in the audit chain (provenance for the review). */
export async function recordDecision(key: string, decision: ReviewDecision): Promise<void> {
  const db = getDb();
  const workflowId = workflowIdForKey(key);
  const row = await getCaseByWorkflowId(db, workflowId);
  await appendAudit(db, {
    caseId: row?.id,
    actor: "pharmacist",
    action: `review.${decision.kind}`,
    detail: { ...decision },
  });
}

/**
 * Poll openFDA + ASHP, merge duplicates across feeds, and open a durable case for every
 * current shortage not already tracked (PROJECT_PLAN §4: "poll → new shortage auto-opens a
 * case"). Idempotent: `startCase`'s `REJECT_DUPLICATE` policy makes an already-open case a
 * no-op here. Runs on a Temporal Schedule (see `scripts/start-schedule.ts`), so this activity
 * itself opens a client connection per invocation rather than holding one across the worker.
 */
export async function pollAndOpenCases(): Promise<{ polled: number; opened: number }> {
  const [openFda, ashp] = await Promise.all([pollOpenFda(), pollAshp()]);
  const current = mergeRecords([...openFda, ...ashp]).filter((r) => r.status === "current");

  const { client, connection } = await makeClient();
  try {
    let opened = 0;
    for (const record of current) {
      const { started } = await startCase(client, record, record.sources);
      if (started) opened += 1;
    }
    return { polled: current.length, opened };
  } finally {
    await connection.close();
  }
}
