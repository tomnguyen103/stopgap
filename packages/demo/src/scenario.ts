import { getEnv } from "@stopgap/core/env";
import type { ShortageRecord } from "@stopgap/core";
import { countCasesOpenedSince, getDb } from "@stopgap/db";

/**
 * "Run a shortage" — the one mutation a demo visitor is allowed (PROJECT_PLAN §11).
 *
 * It starts a REAL case workflow through the real agents; nothing about the run is faked.
 * That is the point of the button, and also why it is fenced:
 *
 * - the drug is chosen from a fixed catalogue, never free text, so visitor input never
 *   reaches a prompt (the injection suite covers feed text; this closes the other door);
 * - keys are `demo-` prefixed, so a demo run can never collide with, or reopen, a case that
 *   the live openFDA poller opened;
 * - starts are rate limited per rolling hour, counted from the case table rather than memory.
 */

export interface DemoDrug {
  key: string;
  genericName: string;
  note: string;
}

/** Fixed catalogue. Each entry exercises a different branch of the case machine. */
export const DEMO_DRUGS: readonly DemoDrug[] = [
  {
    key: "demo-cisplatin",
    genericName: "cisplatin",
    note: "Manufacturing delay reported; multiple presentations affected.",
  },
  {
    key: "demo-lorazepam-injection",
    genericName: "lorazepam injection",
    note: "Increased demand; limited supply of 2 mg/mL vials.",
  },
  {
    key: "demo-amoxicillin-oral-suspension",
    genericName: "amoxicillin oral suspension",
    note: "Demand increase; several strengths on allocation.",
  },
];

export const DEMO_SOURCE_ID_PREFIX = "demo:";

export function findDemoDrug(key: string): DemoDrug | undefined {
  return DEMO_DRUGS.find((d) => d.key === key);
}

export type DemoRunRefusal = {
  ok: false;
  reason: "unknown-drug" | "rate-limited";
  message: string;
};

export type DemoRunResult = { ok: true; workflowId: string; started: boolean } | DemoRunRefusal;

/**
 * Vet a demo run and build the shortage record for it. Starting the workflow is left to the
 * caller so this package doesn't depend on `@stopgap/workflows` — the worker installs the
 * budget guard from here, and a cycle between the two would be a bundling problem waiting to
 * happen.
 */
export async function prepareDemoRun(
  key: string,
): Promise<{ ok: true; record: ShortageRecord } | DemoRunRefusal> {
  const drug = findDemoDrug(key);
  if (!drug) {
    return { ok: false, reason: "unknown-drug", message: `not a demo drug: ${key}` };
  }

  const limit = getEnv().DEMO_MAX_RUNS_PER_HOUR;
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await countCasesOpenedSince(getDb(), DEMO_SOURCE_ID_PREFIX, since);
  if (recent >= limit) {
    return {
      ok: false,
      reason: "rate-limited",
      message: `demo limit reached (${limit} shortage runs per hour) — try again shortly`,
    };
  }

  const record: ShortageRecord = {
    source: "openfda",
    sourceId: `${DEMO_SOURCE_ID_PREFIX}${drug.key}`,
    key: drug.key,
    genericName: drug.genericName,
    status: "current",
    ndcs: [],
    rxcuis: [],
    note: drug.note,
  };
  return { ok: true, record };
}
