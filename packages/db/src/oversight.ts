import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { acknowledgments, alertEvents, alertRules, cases } from "./schema.js";
import type { AlertEventRow } from "./schema.js";
import type { Db } from "./client.js";

/**
 * What a pharmacy director's oversight surface reads (ticket 14).
 *
 * Every query here carries an explicit org predicate as well as relying on RLS, for the reason
 * `docs/multi-tenancy.md` states: the policy is the backstop that makes a bug non-catastrophic,
 * and the explicit filter is what makes the bug visible.
 */

/** One day's counts. `day` is a UTC date string, so two tenants' series line up. */
export interface DailyCount {
  day: string;
  casesOpened: number;
  alertsFired: number;
}

/**
 * Daily counts over a window, with EVERY day present.
 *
 * Generated from a date series and left-joined, rather than grouping the rows that exist: a chart
 * built from present days alone draws a line straight across a week nothing happened, which reads
 * as steady activity instead of none. The gap is the fact worth seeing.
 */
export async function dailyCounts(db: Db, orgId: string, days = 14): Promise<DailyCount[]> {
  const rows = await db.execute<{ day: string; cases_opened: string; alerts_fired: string }>(sql`
    with span as (
      select generate_series(
        (current_date - make_interval(days => ${days - 1}))::date,
        current_date,
        interval '1 day'
      )::date as day
    )
    select to_char(span.day, 'YYYY-MM-DD') as day,
           count(distinct c.id)::text as cases_opened,
           count(distinct e.id)::text as alerts_fired
      from span
      left join ${cases} c
        on c.org_id = ${orgId} and c.opened_at >= span.day and c.opened_at < span.day + 1
      left join ${alertEvents} e
        on e.org_id = ${orgId} and e.fired_at >= span.day and e.fired_at < span.day + 1
     group by span.day
     order by span.day
  `);
  return rows.map((row) => ({
    day: row.day,
    casesOpened: Number(row.cases_opened),
    alertsFired: Number(row.alerts_fired),
  }));
}

/** A critical case nobody has acknowledged, with how far its escalation ladder has run. */
export interface UnacknowledgedCase {
  id: string;
  workflowId: string;
  genericName: string;
  severity: string | null;
  openedAt: Date;
  /** Highest ladder tier recorded for this case, or null when none has been attempted. */
  escalationStep: number | null;
}

/**
 * Critical cases with no acknowledgment (ticket 14).
 *
 * `severity` is the case's own, not a signal's: this is the ladder the escalation policy runs on,
 * and reading a different column here than the ladder reads would show a director a list that does
 * not match who is actually being paged.
 */
export async function unacknowledgedCritical(
  db: Db,
  orgId: string,
  limit = 20,
): Promise<UnacknowledgedCase[]> {
  const rows = await db
    .select({
      id: cases.id,
      workflowId: cases.workflowId,
      genericName: cases.genericName,
      severity: cases.severity,
      openedAt: cases.openedAt,
      escalationStep: sql<number | null>`max(${acknowledgments.step})`,
    })
    .from(cases)
    .leftJoin(
      acknowledgments,
      and(eq(acknowledgments.orgId, orgId), eq(acknowledgments.caseId, cases.id)),
    )
    .where(
      and(
        eq(cases.orgId, orgId),
        eq(cases.severity, "critical"),
        isNull(cases.closedAt),
        // No acknowledgment row at all. A case acknowledged at tier 0 has been seen by someone,
        // which is the whole question this list asks.
        isNull(acknowledgments.id),
      ),
    )
    .groupBy(cases.id, cases.workflowId, cases.genericName, cases.severity, cases.openedAt)
    .orderBy(cases.openedAt)
    .limit(limit);
  return rows;
}

/** One page of alert history, with the rule that produced each event. */
export interface AlertHistoryOptions {
  outcome?: string;
  ruleId?: string;
  page: number;
  pageSize: number;
}

export interface AlertHistoryRow {
  event: AlertEventRow;
  ruleName: string | null;
}

export async function listAlertHistory(
  db: Db,
  orgId: string,
  options: AlertHistoryOptions,
): Promise<{ rows: AlertHistoryRow[]; total: number; page: number }> {
  const predicates = [eq(alertEvents.orgId, orgId)];
  if (options.outcome) predicates.push(eq(alertEvents.outcome, options.outcome));
  if (options.ruleId) predicates.push(eq(alertEvents.ruleId, options.ruleId));
  const where = and(...predicates);
  const [counted] = await db
    .select({ total: sql<string>`count(*)` })
    .from(alertEvents)
    .where(where);
  const total = Number(counted?.total ?? 0);
  // Clamped both ends: the parser bounds the page it takes from a URL, and this function is
  // exported, so a caller passing 0 would otherwise reach OFFSET as a negative number.
  const page = Math.max(1, Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize))));
  const rows = await db
    .select({ event: alertEvents, ruleName: alertRules.name })
    .from(alertEvents)
    .leftJoin(alertRules, and(eq(alertRules.orgId, orgId), eq(alertRules.id, alertEvents.ruleId)))
    .where(where)
    // `id` last so two events fired in the same instant hold a stable order between pages.
    .orderBy(desc(alertEvents.firedAt), desc(alertEvents.id))
    .limit(options.pageSize)
    .offset((page - 1) * options.pageSize);
  return { rows, total, page };
}
