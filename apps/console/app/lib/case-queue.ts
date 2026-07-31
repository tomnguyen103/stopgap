import { CaseStatus } from "@stopgap/core";
import { RISK_DOMAINS, SEVERITIES } from "@stopgap/ingest";

import { parseListParams, type ListParams, type ListParamsSchema } from "./list-params.js";

/**
 * The pharmacist's review queue, as data (ticket 11).
 *
 * The signals list's schema and this one are deliberately separate objects rather than one shared
 * "list schema": they filter different things, and a single schema serving both would have to allow
 * every value either of them accepts — which is how a filter that returns nothing forever gets
 * shipped. The list-state MACHINERY is shared; the vocabulary is not.
 */

/**
 * Statuses a case can hold while it is still open.
 *
 * Derived from the domain enum minus the terminal pair, so a new status added to the contract
 * appears here without an edit, and a status the queue can never contain is never offered as a
 * filter. `closed` and `rejected` are excluded because the queue query itself excludes them:
 * offering a filter that always returns nothing is worse than not offering it.
 */
export const OPEN_CASE_STATUSES: readonly string[] = CaseStatus.options.filter(
  (status) => status !== "closed" && status !== "rejected",
);

export const CASE_QUEUE_SCHEMA: ListParamsSchema = {
  sortKeys: ["score", "updated", "severity", "entity"],
  defaultSort: "score",
  defaultDir: "desc",
  filters: {
    status: OPEN_CASE_STATUSES,
    severity: SEVERITIES,
    domain: RISK_DOMAINS,
  },
  pageSizes: [25, 50, 100],
  defaultPageSize: 25,
};

export function parseCaseQueueParams(input: Parameters<typeof parseListParams>[0]): ListParams {
  return parseListParams(input, CASE_QUEUE_SCHEMA);
}

/**
 * Whether this case is parked in the exception queue.
 *
 * Read off the case's own status rather than recomputed from a confidence against a threshold: the
 * workflow already made that routing decision, and a second copy of the arithmetic in the console
 * is a place for the two to disagree about which queue a case is in.
 */
export function isException(status: string): boolean {
  return status === "exception";
}

/**
 * How a confidence reads to a pharmacist, as a percentage string.
 *
 * Absent confidence is NOT 0% — a protocol reused from organizational memory or written by a
 * pharmacist has no model estimate at all, and rendering that as zero confidence would defame a
 * human decision as the model's worst one.
 */
export function confidenceLabel(confidence: number | undefined): string | null {
  if (confidence === undefined) return null;
  return `${Math.round(confidence * 100)}%`;
}

/**
 * The reason a control is unavailable to this caller, or null when it is available.
 *
 * Returns a SENTENCE rather than a boolean because the ticket asks the disabled control to name
 * the role it needs: a greyed-out button that does not say why reads as a broken page.
 */
export function unavailableReason(
  allowed: boolean,
  requiredRole: string,
  demo: boolean,
): string | null {
  if (demo) return "Disabled in the public demo — clinical decisions need a verified reviewer.";
  if (!allowed) return `Needs the ${requiredRole} role.`;
  return null;
}
