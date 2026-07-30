import type { ShortageRecord } from "@stopgap/core";
import {
  SECOND_ORG_ID,
  SEED_ORG_ID,
  appendAudit,
  approveProtocolVersion,
  draftProtocolVersion,
  getCaseByKey,
  listProtocolVersions,
  updateCaseStatus,
  upsertCaseForRecord,
  withOrgDb,
} from "@stopgap/db";
import { DEMO_SOURCE_ID_PREFIX } from "./scenario.js";

/**
 * The tenants the demo fills (PHASE6 §6.5 acceptance: "two seeded orgs run side by side; cases,
 * protocols, shadow, audit fully disjoint").
 *
 * Both org ROWS are created by migration 0014, not here, because this seeder refuses to run outside
 * `STOPGAP_DEMO_MODE=on` — its cases are fiction and must never sit beside real shortages. An empty
 * organization is not fiction, so it belongs in the migration; the CONTENT belongs here.
 *
 * Each org gets its own subset of the case catalogue rather than a copy of all three, and that is
 * deliberate: two tenants holding identical rows would demonstrate nothing. Different case sets
 * mean switching the active org visibly changes the whole console — which is what an isolation
 * demo has to show — and each org's audit chain runs from its own genesis, so verification of one
 * says nothing about the other.
 */
const SEEDED_ORGS: readonly { orgId: string; caseKeys: readonly string[] }[] = [
  {
    orgId: SEED_ORG_ID,
    caseKeys: ["demo-seed-cefazolin", "demo-seed-heparin", "demo-seed-immune-globulin"],
  },
  // Deliberately overlapping on heparin and disjoint elsewhere: the shared key proves the two
  // tenants can hold a case for the SAME drug without colliding (the `(org_id, key)` and
  // `(org_id, workflow_id)` indexes, and the org-qualified Temporal id), while the differing keys
  // make the isolation visible at a glance.
  { orgId: SECOND_ORG_ID, caseKeys: ["demo-seed-heparin"] },
];

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

/**
 * Seed ONE tenant — the console's entry point (ticket 17).
 *
 * `seedDemoData` writes into both fixed demo orgs, which is right for the nightly job and wrong
 * for a console action: an administrator is authorized in the tenant they are ACTING IN, and a
 * button that writes into two other organizations regardless is authorization and effect
 * disagreeing about who they are about. This seeds the caller's own workspace and nothing else.
 *
 * Every case key, because the split across the two fixed orgs exists to demonstrate isolation
 * BETWEEN them — a single tenant seeding a subset would just be missing data.
 */
export async function seedDemoOrg(orgId: string, now: Date = new Date()): Promise<SeedResult> {
  const caseKeys = SEED_CASES.map((c) => c.key);
  const result = await withOrgDb(orgId, (db) => seedOneOrg(db, orgId, caseKeys, now));
  return {
    cases: result.cases,
    protocolsWritten: result.protocolsWritten,
    reseeded: result.reseeded,
  };
}

/** Idempotent: safe to run nightly (and safe to run twice in a row). */
export async function seedDemoData(now: Date = new Date()): Promise<SeedResult> {
  let cases = 0;
  let protocolsWritten = 0;
  let reseeded = false;

  for (const org of SEEDED_ORGS) {
    // One scope per org, not one for the whole run: `withOrgDb` sets `app.current_org` for its
    // transaction, so seeding two tenants inside a single scope would have the second org's
    // inserts refused by the first org's RLS policy — the seeder proving the isolation it is
    // meant to demonstrate, by failing.
    const result = await withOrgDb(org.orgId, (db) =>
      seedOneOrg(db, org.orgId, org.caseKeys, now),
    );
    cases += result.cases;
    protocolsWritten += result.protocolsWritten;
    reseeded ||= result.reseeded;
  }

  return { cases, protocolsWritten, reseeded };
}

/** The per-tenant half of the seed, run inside that tenant's `withOrgDb` scope. */
async function seedOneOrg(
  db: Parameters<Parameters<typeof withOrgDb>[1]>[0],
  orgId: string,
  caseKeys: readonly string[],
  now: Date,
): Promise<SeedResult> {
  let protocolsWritten = 0;
  let reseeded = false;
  const seeds = SEED_CASES.filter((c) => caseKeys.includes(c.key));

  for (const seed of seeds) {
    const existing = await getCaseByKey(db, orgId, seed.key);
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
    const row = await upsertCaseForRecord(db, orgId, record);

    // The row's OWN workflow id, never a recomputed one: a case seeded before the org-qualified
    // format still carries `case-<key>`, and updating by a recomputed id would match nothing.
    await updateCaseStatus(db, orgId, row.workflowId, seed.status, {
      severity: seed.severity,
      lastNote: seed.lastNote,
      openedAt: new Date(now.getTime() - seed.ageDays * DAY_MS),
    });

    await appendAudit(db, {
      orgId,
      caseId: row.id,
      actor: "demo-seed",
      action: "demo.seeded",
      detail: { status: seed.status, ageDays: seed.ageDays, seededAt: now.toISOString() },
      // One entry per seed run rather than one forever: the idempotency key includes the
      // event key, so a nightly re-seed appends today's entry and yesterday's stays put.
      eventKey: `demo.seeded:${now.toISOString().slice(0, 10)}`,
    });

    if (seed.protocol) {
      const versions = await listProtocolVersions(orgId, seed.key, db);
      if (versions.length === 0) {
        const version = await draftProtocolVersion(
          {
            orgId,
            key: seed.key,
            title: seed.protocol.title,
            drugClass: seed.protocol.drugClass,
            body: seed.protocol.body,
            alternatives: seed.protocol.alternatives,
            sourceCaseId: row.id,
            authoredBy: seed.protocol.authoredBy,
            rationale: seed.protocol.rationale,
          },
          db,
        );
        if (seed.protocol.approve) {
          await approveProtocolVersion(orgId, version.id, "pharmacist-demo", null, db);
        }
        protocolsWritten += 1;
      }
    }
  }

  return { cases: seeds.length, protocolsWritten, reseeded };
}

/** The keys the seeder owns, so the console can label them honestly. */
export const SEED_CASE_KEYS: readonly string[] = SEED_CASES.map((c) => c.key);
