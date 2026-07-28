/**
 * Alert rules and cooldowns (ticket 12).
 *
 * PURE. No database, no network, no clock — every decision is a function of the rules, the signals
 * and an evaluation time the caller supplies. The write half lives in `@stopgap/db` and the send
 * half in `@stopgap/comms`; this module only decides.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW THIS RECONCILES WITH THE ESCALATION LADDER
 * ---------------------------------------------------------------------------------------------
 *
 * Two mechanisms overlapped and are now one thing each:
 *
 *  - **Rules own TRIGGERING.** What is worth telling someone about, and how often. That is this
 *    module: matching, severity floors, and the cooldown that turns a burst into one notification.
 *  - **The ladder owns OWNERSHIP.** Who is told, whether they acknowledged, and what happens when
 *    nobody does. That is `escalation_policies` and the existing acknowledgment flow, unchanged.
 *
 * The split is drawn there because the two answer different questions and fail differently. A rule
 * that fired but reached nobody is a DELIVERY problem; a rule that never fired is a POLICY problem.
 * Merging them would have produced one component whose failure mode is "someone should have been
 * told something" — which is not a debuggable statement.
 *
 * Concretely: this module never decides a recipient, and the ladder never decides whether an event
 * is worth sending. An alert event hands off to the ladder at the moment it is recorded.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY COOLDOWNS ARE CORRECTNESS, NOT POLISH
 * ---------------------------------------------------------------------------------------------
 *
 * One recorded ingestion run opened fifty-seven cases. Without a cooldown that is fifty-seven
 * notifications from a single event, and the thing a recipient learns is to filter the channel.
 * A channel people filter is worse than no channel, because the system still believes it told
 * them. So the cooldown is not a nicety layered on top — it is what makes the notification mean
 * anything at all.
 */

/** Severity, in the ingestion contract's order. The index is the rank, as everywhere else. */
export const ALERT_SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

const SEVERITY_RANK: Record<string, number> = Object.fromEntries(
  ALERT_SEVERITIES.map((s, i) => [s, i]),
);

/** Where a fired alert is sent. The ladder decides WHO; this is only the medium. */
export const ALERT_CHANNELS = ["email", "chat"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * Restrict to one risk domain (`shortage`, `recall`), or leave unset for any.
   *
   * This is the "categories" axis. A director who wants recalls in a different channel from
   * shortages writes two rules rather than one rule with two behaviours.
   */
  riskDomain?: string;
  /**
   * Restrict to entities whose identifier CONTAINS this text, case-insensitively.
   *
   * Substring rather than exact match: a facility says "heparin" and means every heparin product
   * the feeds name, which they never spell the same way twice. Deliberately not a regular
   * expression — a rule a director writes must not be able to hang the evaluator.
   */
  entityContains?: string;
  /** The floor. A signal below this never fires this rule. */
  minSeverity: AlertSeverity;
  /** Minimum minutes between two notifications from this rule. */
  cooldownMinutes: number;
  channels: AlertChannel[];
}

/** What the evaluator needs from a scored signal. */
export interface AlertableSignal {
  signalId: string;
  dedupeKey: string;
  riskDomain: string;
  entityIdentifier: string;
  severity: string;
  /** The deterministic score, for the notification's body. Never a threshold on its own. */
  score: number;
  title: string;
}

export interface EvaluationInput {
  rules: AlertRule[];
  signals: AlertableSignal[];
  /** When each rule last FIRED, by rule id. Absent means it never has. */
  lastFiredAt: Record<string, string>;
  /** ISO 8601, supplied by the caller — this module never reads the clock. */
  evaluatedAt: string;
}

export interface FiredAlert {
  rule: AlertRule;
  /**
   * EVERY signal that matched in this evaluation, not just the first.
   *
   * This is what makes a cooldown a summary rather than a truncation: fifty-seven matching signals
   * produce one notification that names fifty-seven, instead of one notification that names one and
   * fifty-six that were silently dropped.
   */
  matched: AlertableSignal[];
  /** Stable per (rule, window) — the key that makes a retried send a no-op. */
  idempotencyKey: string;
}

export interface SuppressedAlert {
  rule: AlertRule;
  matched: AlertableSignal[];
  reason: "cooldown";
  /** When this rule may fire again. */
  nextEligibleAt: string;
}

export interface Evaluation {
  fired: FiredAlert[];
  suppressed: SuppressedAlert[];
}

/** Does this signal satisfy this rule's filters? */
export function ruleMatches(rule: AlertRule, signal: AlertableSignal): boolean {
  if (!rule.enabled) return false;
  if (rule.riskDomain && rule.riskDomain !== signal.riskDomain) return false;
  if (
    rule.entityContains &&
    !signal.entityIdentifier.toLowerCase().includes(rule.entityContains.toLowerCase())
  ) {
    return false;
  }
  const floor = SEVERITY_RANK[rule.minSeverity];
  const actual = SEVERITY_RANK[signal.severity];
  // An unknown severity does NOT fire. A feed inventing a label is a feed this deployment has not
  // been taught to read, and guessing it clears a director's floor is the wrong direction to guess.
  if (floor === undefined || actual === undefined) return false;
  return actual >= floor;
}

/** When a rule that fired at `lastFired` may fire again. */
export function nextEligibleAt(rule: AlertRule, lastFired: string): string {
  return new Date(Date.parse(lastFired) + rule.cooldownMinutes * 60_000).toISOString();
}

/**
 * The idempotency key for one firing.
 *
 * Keyed on the rule and the COOLDOWN WINDOW the evaluation falls in, not on the signals: a retry
 * that re-evaluates the same moment produces the same key even if the feed has since returned one
 * more matching signal, so the retry is a no-op rather than a second notification.
 */
export function firingKey(rule: AlertRule, evaluatedAt: string): string {
  const windowMs = Math.max(1, rule.cooldownMinutes) * 60_000;
  const window = Math.floor(Date.parse(evaluatedAt) / windowMs);
  return `${rule.id}:${window}`;
}

/**
 * Decide what fires.
 *
 * One firing per RULE, never one per signal — that is the whole point. A rule still inside its
 * cooldown is reported as suppressed with the time it becomes eligible again, rather than dropped:
 * "this rule matched twelve signals and stayed quiet until 14:20" is a thing a director tuning
 * rules needs to be able to read.
 */
export function evaluateAlerts(input: EvaluationInput): Evaluation {
  const fired: FiredAlert[] = [];
  const suppressed: SuppressedAlert[] = [];

  for (const rule of input.rules) {
    const matched = input.signals.filter((signal) => ruleMatches(rule, signal));
    if (matched.length === 0) continue;

    const lastFired = input.lastFiredAt[rule.id];
    if (lastFired) {
      const eligible = nextEligibleAt(rule, lastFired);
      if (Date.parse(input.evaluatedAt) < Date.parse(eligible)) {
        suppressed.push({ rule, matched, reason: "cooldown", nextEligibleAt: eligible });
        continue;
      }
    }
    fired.push({ rule, matched, idempotencyKey: firingKey(rule, input.evaluatedAt) });
  }

  return { fired, suppressed };
}

/**
 * The notification body for one firing.
 *
 * Leads with the COUNT, because the number of matching signals is the thing a burst is about, and
 * a message that opens with one drug's name reads as one drug's problem. Lists at most `limit`
 * of them and says how many it left out — a message nobody scrolls is a message nobody read.
 */
export function summarize(alert: FiredAlert, limit = 10): { subject: string; body: string } {
  const count = alert.matched.length;
  const shown = alert.matched.slice(0, limit);
  const remainder = count - shown.length;
  const lines = shown.map(
    (s) => `- [${s.severity}] ${s.entityIdentifier} — ${s.title} (score ${s.score})`,
  );
  if (remainder > 0) lines.push(`- …and ${remainder} more`);
  return {
    subject: `${alert.rule.name}: ${count} matching signal${count === 1 ? "" : "s"}`,
    body: [
      `Rule "${alert.rule.name}" matched ${count} signal${count === 1 ? "" : "s"}.`,
      "",
      ...lines,
      "",
      `Next notification from this rule no earlier than ${alert.rule.cooldownMinutes} minutes from now.`,
    ].join("\n"),
  };
}
