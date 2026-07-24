import type { ShortageRecord } from "@stopgap/core";
import {
  appendAudit,
  approveProtocolVersion,
  draftProtocolVersion,
  getCaseByWorkflowId,
  getDb,
  listProtocolVersions,
  updateCaseStatus,
  upsertCaseForRecord,
  workflowIdForKey,
} from "@stopgap/db";
import { DEMO_SOURCE_ID_PREFIX } from "./scenario.js";

/**
 * Nightly demo re-seed (PROJECT_PLAN §11): three cases parked at believable points in their
 * lifecycle — one waiting on a pharmacist, one in long-tail monitoring, one stuck in the
 * exception queue — plus the protocol history behind them.
 *
 * Two properties this deliberately keeps:
 *
 * - **Nothing is deleted.** `audit_log` is an append-only hash chain, so a re-seed that
 *   cleaned up after itself would break verification for every later row. Re-seeding instead
 *   updates the same demo case rows in place and appends a `demo.reseed` entry.
 * - **No metrics are invented.** The seed writes cases and protocols — things a demo needs in
 *   order to have anything to click — and never shadow-ledger rows or KPI figures. The shadow
 *   dashboard on a deployment is populated by running the real replay (`pnpm --filter
 *   @stopgap/shadow replay`), so every agreement number on it was actually measured.
 *
 * Seeded cases have no live Temporal workflow: they are the database mirror of one. The
 * "Run a shortage" button is the part of the demo that drives the real engine.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface SeedCase {
  key: string;
  genericName: string;
  ageDays: number;
  status: "awaiting_review" | "monitoring" | "exception";
  severity: "moderate" | "high" | "critical";
  lastNote: string;
  protocol?: {
    title: string;
    drugClass: string;
    body: string;
    alternatives: string[];
    /** Approved versions show as live guidance; drafts sit in the review queue. */
    approve: boolean;
    authoredBy: string;
    rationale: string;
  };
}

const SEED_CASES: readonly SeedCase[] = [
  {
    key: "demo-seed-cefazolin",
    genericName: "cefazolin",
    ageDays: 2,
    status: "awaiting_review",
    severity: "high",
    lastNote: "Agent draft ready for pharmacist review.",
    protocol: {
      title: "Cefazolin shortage — substitution guidance",
      drugClass: "cephalosporin",
      body: [
        "Reserve remaining cefazolin for surgical prophylaxis.",
        "For non-surgical indications, use cefuroxime or nafcillin per indication.",
        "Confirm the substitution with the treating team before switching an inpatient course.",
      ].join("\n"),
      alternatives: ["cefuroxime", "nafcillin"],
      approve: false,
      authoredBy: "agent",
      rationale: "Drafted from the shortage record; awaiting pharmacist review.",
    },
  },
  {
    key: "demo-seed-heparin",
    genericName: "heparin sodium",
    ageDays: 18,
    status: "monitoring",
    severity: "critical",
    lastNote: "Protocol approved and communicated; monitoring weekly for resupply.",
    protocol: {
      title: "Heparin shortage — conservation protocol",
      drugClass: "anticoagulant",
      body: [
        "Restrict heparin flushes to lines that require them; use saline elsewhere.",
        "Therapeutic anticoagulation continues on heparin where an alternative is unsafe.",
        "Consider argatroban only for patients with a documented contraindication.",
      ].join("\n"),
      alternatives: ["argatroban", "saline flush (line maintenance only)"],
      approve: true,
      authoredBy: "agent",
      rationale: "Approved with edits by pharmacy after review of the agent draft.",
    },
  },
  {
    key: "demo-seed-immune-globulin",
    genericName: "immune globulin (IVIG)",
    ageDays: 45,
    status: "exception",
    severity: "critical",
    lastNote: "Parked: no therapeutic equivalent — needs a pharmacist decision.",
  },
];

export interface SeedResult {
  cases: number;
  protocolsWritten: number;
  reseeded: boolean;
}

/** Idempotent: safe to run nightly (and safe to run twice in a row). */
export async function seedDemoData(now: Date = new Date()): Promise<SeedResult> {
  const db = getDb();
  let protocolsWritten = 0;
  let reseeded = false;

  for (const seed of SEED_CASES) {
    const workflowId = workflowIdForKey(seed.key);
    const existing = await getCaseByWorkflowId(db, workflowId);
    reseeded ||= Boolean(existing);

    const record: ShortageRecord = {
      source: "openfda",
      sourceId: `${DEMO_SOURCE_ID_PREFIX}seed-${seed.key}`,
      key: seed.key,
      genericName: seed.genericName,
      status: "current",
      ndcs: [],
      rxcuis: [],
      note: seed.lastNote,
    };
    const row = await upsertCaseForRecord(db, record);

    await updateCaseStatus(db, workflowId, seed.status, {
      severity: seed.severity,
      lastNote: seed.lastNote,
      openedAt: new Date(now.getTime() - seed.ageDays * DAY_MS),
    });

    await appendAudit(db, {
      caseId: row.id,
      actor: "demo-seed",
      action: "demo.seeded",
      detail: { status: seed.status, ageDays: seed.ageDays, seededAt: now.toISOString() },
      // One entry per seed run rather than one forever: the idempotency key includes the
      // event key, so a nightly re-seed appends today's entry and yesterday's stays put.
      eventKey: `demo.seeded:${now.toISOString().slice(0, 10)}`,
    });

    if (seed.protocol) {
      const versions = await listProtocolVersions(seed.key);
      if (versions.length === 0) {
        const version = await draftProtocolVersion({
          key: seed.key,
          title: seed.protocol.title,
          drugClass: seed.protocol.drugClass,
          body: seed.protocol.body,
          alternatives: seed.protocol.alternatives,
          sourceCaseId: row.id,
          authoredBy: seed.protocol.authoredBy,
          rationale: seed.protocol.rationale,
        });
        if (seed.protocol.approve) await approveProtocolVersion(version.id, "pharmacist-demo");
        protocolsWritten += 1;
      }
    }
  }

  return { cases: SEED_CASES.length, protocolsWritten, reseeded };
}

/** The keys the seeder owns, so the console can label them honestly. */
export const SEED_CASE_KEYS: readonly string[] = SEED_CASES.map((c) => c.key);
