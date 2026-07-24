import { Context } from "@temporalio/activity";
import type { CaseStatus, Severity } from "@stopgap/core";
import {
  appendAudit,
  approveProtocolVersion,
  draftProtocolVersion,
  getApprovedProtocol,
  getCaseByWorkflowId,
  getDb,
  recordFeedRecords,
  updateCaseStatus,
  upsertCaseForRecord,
  workflowIdForKey,
} from "@stopgap/db";
import { sendEhrFlag, sendEmail } from "@stopgap/comms";
import { contentHash, mergeRecords, pollAshp, pollOpenFda } from "@stopgap/ingest";
import * as agents from "@stopgap/agents";
import { makeClient, startCase } from "./client.js";
import type {
  CaseInput,
  ImpactResult,
  ProtocolMemoryHit,
  RecordProtocolInput,
  ResearchResult,
  ReviewDecision,
} from "./shared.js";

/**
 * Activities are the only place workflows touch the outside world (DB, feeds, LLMs). The
 * judgment activities (`assessImpact`, `researchAlternatives`) call the Zod-validated AI SDK
 * agents in `@stopgap/agents` (PROJECT_PLAN §8: "schema-validated outputs everywhere",
 * temperature 0 for eval reproducibility). The DB-side effects are real. Every activity is
 * idempotent so Temporal retries are safe.
 */

/**
 * The workflow run an activity is executing for. Audit entries are idempotent per run, so a
 * recurring shortage (a new run against the same case row) appends its own trail instead of
 * colliding with the previous run's.
 */
function currentRunId(): string | undefined {
  return Context.current().info.workflowExecution?.runId;
}

/** Persist a newly detected case and open the audit chain. Idempotent (upsert). */
export async function recordDetected(input: CaseInput): Promise<void> {
  const db = getDb();
  const row = await upsertCaseForRecord(db, input.record);
  await appendAudit(db, {
    caseId: row.id,
    actor: "system",
    action: "case.detected",
    detail: { key: input.record.key, sources: input.sources },
    runId: currentRunId(),
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
    runId: currentRunId(),
    // The monitoring loop persists `case.monitoring` every completed week, so the week
    // number has to be part of the idempotency key — otherwise week 2 onwards look like
    // retries of week 1 and never reach the audit trail.
    eventKey:
      detail.monitoringWeeks === undefined
        ? `case.${status}`
        : `case.${status}.week-${String(detail.monitoringWeeks)}`,
  });
}

/** Impact assessment via the Zod-validated AI SDK agent (Gemini/Ollama, health-routed). */
export async function assessImpact(input: CaseInput): Promise<ImpactResult> {
  return agents.assessImpact(input.record);
}

/** Alternatives research via the Zod-validated AI SDK agent (Gemini/Ollama, health-routed). */
export async function researchAlternatives(input: CaseInput): Promise<ResearchResult> {
  return agents.researchAlternatives(input.record);
}

/**
 * Outbound comms: email the approved protocol to the pharmacy list and flag the substitution
 * in the EHR (PROJECT_PLAN §5). Both channels are keyed on the case + run so an activity
 * retry cannot page the pharmacy twice, and a non-delivery (no credentials, unreachable
 * endpoint) is recorded in the audit trail rather than swallowed — "we told the floor" has to
 * be falsifiable.
 */
export async function sendComms(
  key: string,
  draft: string,
  alternatives: string[] = [],
): Promise<{ delivered: boolean }> {
  const db = getDb();
  const workflowId = workflowIdForKey(key);
  const row = await getCaseByWorkflowId(db, workflowId);
  const idempotencyKey = `${workflowId}:${currentRunId() ?? "no-run"}:comms`;
  const results = await Promise.all([
    sendEmail({
      idempotencyKey: `${idempotencyKey}:email`,
      subject: `Drug shortage protocol: ${key}`,
      body: draft,
      to: [],
    }),
    sendEhrFlag({ idempotencyKey: `${idempotencyKey}:ehr`, key, alternatives, body: draft }),
  ]);
  await appendAudit(db, {
    caseId: row?.id,
    actor: "system",
    action: "comms.sent",
    detail: { chars: draft.length, channels: results },
    runId: currentRunId(),
  });
  // Reported back so the case records whether anything actually went out — the `comms_sent`
  // state means "we tried", and a case that claims delivery no transport performed would be
  // exactly the kind of unfalsifiable assertion this system is supposed to avoid.
  return { delivered: results.some((result) => result.delivered) };
}

/** Record a HITL decision in the audit chain (provenance for the review). */
export async function recordDecision(key: string, decision: ReviewDecision): Promise<void> {
  const db = getDb();
  const workflowId = workflowIdForKey(key);
  const row = await getCaseByWorkflowId(db, workflowId);
  await appendAudit(db, {
    caseId: row?.id,
    // The signal is unauthenticated, so the actor is whoever the caller claimed to be. Writing
    // a bare "pharmacist" here would put an unverifiable assertion into a tamper-evident log.
    actor: decision.reviewer ?? "unknown-reviewer",
    action: `review.${decision.kind}`,
    detail: { ...decision, identitySource: "workflow-signal-claim" },
    runId: currentRunId(),
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
  const fetched = [...openFda, ...ashp];
  // Persist what the feeds returned before deciding what to do with it: `feed_records` is the
  // provenance trail behind every case, and the only thing that can answer "when did this
  // deployment last hear from openFDA" (the console's freshness panel). Resolved records are
  // stored too — a shortage dropping off the feed is information.
  await recordFeedRecords(getDb(), fetched, contentHash);
  const current = mergeRecords(fetched).filter((r) => r.status === "current");

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

/**
 * Look up the approved protocol for this shortage key — the organizational-memory read
 * (PROJECT_PLAN §3B/§4). A hit means a pharmacist already approved substitution guidance for
 * this drug, so the case reuses it instead of paying for a fresh research call and asking a
 * human to re-approve text they already wrote.
 */
export async function lookupProtocol(key: string): Promise<ProtocolMemoryHit | undefined> {
  const found = await getApprovedProtocol(key);
  if (!found) return undefined;
  return {
    versionId: found.version.id,
    version: found.version.version,
    body: found.version.body,
    alternatives: found.version.alternatives,
  };
}

/**
 * Write the approved outcome of this case back into the protocol store, then approve it —
 * this is what turns a one-off resolution into organizational memory. Provenance (source
 * case, author, approver, rationale) is recorded on the version row.
 */
export async function recordProtocolVersion(input: RecordProtocolInput): Promise<void> {
  const db = getDb();
  const row = await getCaseByWorkflowId(db, workflowIdForKey(input.key));
  // Idempotent under retry: an activity whose insert committed before the worker crashed
  // would otherwise write a second identical version and supersede the one it just approved.
  // The retry still re-appends the audit entry (itself idempotent) — a crash between the
  // approval commit and the audit append would otherwise leave an approved protocol version
  // with no record of who approved it.
  const current = await getApprovedProtocol(input.key);
  if (current && current.version.body === input.body) {
    await appendAudit(db, {
      caseId: row?.id,
      actor: input.approvedBy,
      action: "protocol.version_approved",
      detail: {
        key: input.key,
        version: current.version.version,
        authoredBy: input.authoredBy,
        identitySource: "workflow-signal-claim",
      },
      runId: currentRunId(),
      eventKey: `protocol.version_approved.v${String(current.version.version)}`,
    });
    return;
  }
  const drafted = await draftProtocolVersion({
    key: input.key,
    title: input.title,
    body: input.body,
    alternatives: input.alternatives,
    sourceCaseId: row?.id ?? null,
    authoredBy: input.authoredBy,
    rationale: input.rationale ?? null,
  });
  await approveProtocolVersion(drafted.id, input.approvedBy);
  await appendAudit(db, {
    caseId: row?.id,
    actor: input.approvedBy,
    action: "protocol.version_approved",
    detail: {
      key: input.key,
      version: drafted.version,
      authoredBy: input.authoredBy,
      // `approvedBy` arrives on a workflow signal and is not an authenticated principal —
      // anyone able to signal the workflow picks the string. Recording that provenance
      // honestly is the Phase 3 answer; verifying identity needs the auth layer the Phase 4
      // review UI introduces (see PHASE5-TODO).
      identitySource: "workflow-signal-claim",
    },
    runId: currentRunId(),
    eventKey: `protocol.version_approved.v${String(drafted.version)}`,
  });
}
