import { sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { auditLog, cases } from "./schema.js";

/**
 * KPI aggregates for the console dashboard (PROJECT_PLAN §14). Every number here comes from
 * the durable case + audit tables, never from a counter incremented in application code: a
 * counter drifts the first time a process dies mid-update, and these are the numbers the
 * whole "did this actually help" argument rests on.
 */
export interface Kpis {
  totalCases: number;
  openCases: number;
  /** Cases parked in the exception queue right now. */
  exceptionCases: number;
  /** Cases that reached a terminal state (closed or rejected). */
  terminalCases: number;
  /**
   * Cases with no terminal state and no activity in over 90 days — the "0 dropped cases"
   * metric. A dropped case is the failure this platform exists to prevent, so it is counted
   * explicitly rather than inferred from the absence of something.
   */
  droppedCases: number;
  /** Median hours from case detection to pharmacist approval, over approved cases. */
  medianHoursToApproval: number | undefined;
  /** Share of reviewed drafts approved with no pharmacist edit (PROJECT_PLAN §14: ≥ 80%). */
  draftAcceptanceRate: number | undefined;
  reviewedCases: number;
}

const STALE_CASE_DAYS = 90;

export async function getKpis(): Promise<Kpis> {
  const db = getDb();

  const [counts] = await db
    .select({
      total: sql<string>`count(*)`,
      open: sql<string>`count(*) filter (where ${cases.closedAt} is null and ${cases.status} not in ('closed', 'rejected'))`,
      exceptions: sql<string>`count(*) filter (where ${cases.status} = 'exception')`,
      terminal: sql<string>`count(*) filter (where ${cases.status} in ('closed', 'rejected'))`,
      dropped: sql<string>`count(*) filter (where ${cases.status} not in ('closed', 'rejected') and ${cases.updatedAt} < now() - interval '${sql.raw(String(STALE_CASE_DAYS))} days')`,
    })
    .from(cases);

  // Detection-to-approval latency from the audit trail rather than case timestamps:
  // `cases.updatedAt` moves on with every later transition, so it cannot answer "how long did
  // the pharmacist wait" once the case reaches monitoring.
  //
  // Correlated on run_id, not just case_id: a recurring shortage opens a new run against the
  // same case row, so joining on the case alone pairs run 2's detection with run 1's approval
  // and yields both duplicate and negative durations.
  const [latency] = await db.execute<{ median_hours: string | null }>(sql`
    with pairs as (
      select distinct on (detected.case_id, detected.run_id)
             extract(epoch from (approved.ts - detected.ts)) / 3600 as hours
      from ${auditLog} detected
      join ${auditLog} approved
        on approved.case_id = detected.case_id
       and approved.run_id = detected.run_id
       and approved.action = 'case.approved'
       and approved.ts >= detected.ts
      where detected.action = 'case.detected'
      order by detected.case_id, detected.run_id, approved.ts
    )
    select percentile_cont(0.5) within group (order by hours) as median_hours from pairs
  `);

  const [review] = await db.execute<{ reviewed: string; unedited: string }>(sql`
    select count(*) filter (where action in ('review.approve', 'review.edit', 'review.reject')) as reviewed,
           count(*) filter (where action = 'review.approve') as unedited
    from ${auditLog}
  `);

  const reviewed = Number(review?.reviewed ?? 0);
  return {
    totalCases: Number(counts?.total ?? 0),
    openCases: Number(counts?.open ?? 0),
    exceptionCases: Number(counts?.exceptions ?? 0),
    terminalCases: Number(counts?.terminal ?? 0),
    droppedCases: Number(counts?.dropped ?? 0),
    medianHoursToApproval:
      latency?.median_hours == null ? undefined : Number(latency.median_hours),
    draftAcceptanceRate: reviewed === 0 ? undefined : Number(review?.unedited ?? 0) / reviewed,
    reviewedCases: reviewed,
  };
}
