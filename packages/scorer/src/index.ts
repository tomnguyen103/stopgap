/**
 * The deterministic risk scorer (ticket 07; spec, "Risk scoring").
 *
 * PURE. No database, no network, no framework, no clock — the evaluation timestamp is an argument,
 * because a scorer that reads `Date.now()` produces a different number for the same inputs on every
 * call, and a queue that reorders itself between two page loads is one nobody trusts.
 *
 * Per ADR-0002 this sits squarely on the deterministic side of the spine. A language model drafts
 * prose and proposes alternatives; it never computes, adjusts or overrides a score. The reason is
 * not purity for its own sake — it is that "why is this case first" has to have an answer a
 * pharmacist can check, and an answer that is arithmetic can be checked.
 *
 * Four guarantees, each argued beside the constant that enforces it below:
 *
 *  - **Deterministic** — identical inputs and an identical `evaluatedAt` give an identical output.
 *  - **Explainable** — every score carries a per-component breakdown.
 *  - **Versioned** — `SCORER_VERSION` is pinned into every snapshot; any change to a weight or to
 *    the formula bumps it.
 *  - **Monotonic** — an additional matched signal can raise a score and never lower it; an
 *    additional matched risk domain contributes at a shrinking but strictly positive factor; a
 *    source-resolved hazard is decayed rather than dropped and still contributes non-negatively.
 */

/**
 * Bumped by ANY change to a weight, a constant or the formula.
 *
 * Pinned into every persisted snapshot, because a score without the version that produced it is not
 * reproducible — and a queue whose ordering changed last Tuesday for reasons nobody can reconstruct
 * is worse than no ranking at all.
 */
export const SCORER_VERSION = "1.0.0";

/**
 * The score budget, out of 100.
 *
 * A third of it is structurally unreachable until the catalog slice lands, and the scorer says so
 * rather than quietly scoring out of 65 and presenting it as 100. Scores stay valid, comparable and
 * monotonic while incomplete; what they must never be is silently incomplete.
 */
export const COMPONENT_BUDGET = {
  signalExposure: 65,
  daysOnHand: 20,
  soleSource: 15,
} as const;

export type ComponentName = keyof typeof COMPONENT_BUDGET;

/**
 * Freshness half-life, in days.
 *
 * The scorer decays by EXACT age rather than by the signal's coarse `staleness` label: both derive
 * from the same timestamps, so they cannot disagree about which evidence is older — only about how
 * coarsely they say it. The label is for a filter a pharmacist applies; this is for arithmetic.
 */
export const FRESHNESS_HALF_LIFE_DAYS = 21;

/**
 * The floor a decayed signal cannot fall below.
 *
 * Strictly positive, so age never turns a matched hazard into a zero. A two-year-old recall of a
 * product this facility stocks is weak evidence, not absent evidence, and a floor of 0 would make
 * the monotonicity guarantee vacuous for old signals.
 */
export const FRESHNESS_FLOOR = 0.15;

/**
 * What a source-resolved hazard keeps.
 *
 * DECAYED, not dropped — the distinction the whole contract is built around. A recall terminated
 * last week still bears on what is safe to substitute into today, so it contributes less rather
 * than nothing. Strictly positive for the same reason as the freshness floor.
 */
export const SOURCE_RESOLVED_FACTOR = 0.35;

/**
 * How much each additional matched risk domain is worth, in rank order.
 *
 * Shrinking but strictly positive: a facility facing both a shortage AND a recall on the same
 * product is more exposed than one facing either alone, but not twice as exposed. The array is
 * indexed by RANK, not by domain — the strongest domain takes the first weight — which is what
 * keeps the sum monotone when a new domain appears.
 *
 * Its length is EXACTLY the number of risk domains the contract admits, and that is what makes
 * "shrinking but strictly positive" true of every domain that can actually occur. A domain beyond
 * the table would contribute nothing — deliberately, because the 65-point budget is fixed and a
 * weight invented at runtime would silently change what a score means. Adding a risk domain is
 * therefore a code change: a weight here, and a `SCORER_VERSION` bump.
 */
export const DOMAIN_RANK_WEIGHTS = [1, 0.5] as const;

/**
 * The weight for any rank, including one past the table.
 *
 * Halving continues beyond the listed pair rather than dropping to zero. The contract has two risk
 * domains today, so the table covers it — but `ScorableSignal.riskDomain` is a string, and a third
 * domain reaching the scorer with weight 0 would break the property stated above it: each further
 * matched domain is worth strictly less, and strictly more than nothing. A silent zero would also
 * make the score non-monotonic — adding a hazard could leave the number unchanged.
 */
export function domainRankWeight(rank: number): number {
  const listed = DOMAIN_RANK_WEIGHTS[rank];
  if (listed !== undefined) return listed;
  const lastIndex = DOMAIN_RANK_WEIGHTS.length - 1;
  const last = DOMAIN_RANK_WEIGHTS[lastIndex] ?? 1;
  return last / Math.pow(2, rank - lastIndex);
}

/**
 * The denominator: what a signal set matching EVERY ranked domain could earn.
 *
 * Computed from the domains actually present, not from the table's fixed sum — with a third domain
 * in play, dividing by the two-domain total would let the component exceed its budget.
 */
function domainWeightTotal(count: number): number {
  let total = 0;
  for (let rank = 0; rank < Math.max(count, DOMAIN_RANK_WEIGHTS.length); rank++) {
    total += domainRankWeight(rank);
  }
  return total;
}

/** Bands, read off the same number. Ordered low to high; the index is the rank, as with severity. */
export const SCORE_BANDS = ["low", "moderate", "high", "critical"] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/**
 * Lower bound of each band, as a FRACTION of what this score could reach.
 *
 * A fraction rather than absolute points, because the reachable maximum moves: today 65 of 100 can
 * be earned, and after the catalog slice lands it is 100. Banding against the absolute ladder while
 * two components are dormant would put `critical` permanently out of reach — a ranked queue on
 * which nothing can ever be critical is not a ranked queue. The fraction keeps the bands meaningful
 * at both stages and comparable across them.
 */
export const BAND_THRESHOLDS: Record<ScoreBand, number> = {
  low: 0,
  moderate: 0.2,
  high: 0.4,
  critical: 0.6,
};

/** What the scorer needs from a signal. A subset of the normalized contract, and nothing raw. */
export interface ScorableSignal {
  dedupeKey: string;
  source: string;
  riskDomain: string;
  severity: string;
  /** [0,1]. Carried beside the label so the scorer never re-derives it from four buckets. */
  severityScore: number;
  /** [0,1]. The shared default lives in `@stopgap/ingest`; the scorer only consumes it. */
  confidence: number;
  /** ISO 8601. Decay is measured from here to `evaluatedAt`. */
  publishedAt: string;
  sourceResolved: boolean;
}

/** Catalog-derived inputs. Absent until the catalog slice lands — absent, not zero. */
export interface CatalogExposure {
  /** Days of stock remaining at current burn. */
  daysOnHand?: number;
  /** Distinct supplier sites that can supply the item. 1 is sole-source. */
  supplierSiteCount?: number;
  /**
   * Which matched items have exactly one source of supply.
   *
   * Carried into the component's `detail`, which is what gets persisted on the snapshot: "this
   * signal scored 12 of 15 for sole-source exposure" is not actionable, and "…because items X and
   * Y have one supplier each" is. The scorer does not compute this — it reports it.
   */
  soleSourcedItemIds?: string[];
}

export interface ScoreInput {
  signals: ScorableSignal[];
  catalog?: CatalogExposure;
  /** ISO 8601. Supplied by the caller — the scorer never reads the clock. */
  evaluatedAt: string;
}

export interface ScoreComponent {
  name: ComponentName;
  points: number;
  max: number;
  /**
   * FALSE means "this could not be computed", never "this computed to zero".
   *
   * The difference is the whole honest-incompleteness stance: a console that renders an
   * unavailable component as 0 is telling a pharmacist the facility has no stock exposure, which
   * is a claim the system has no basis for.
   */
  available: boolean;
  /** Why it is unavailable, when it is. Absent otherwise. */
  unavailableReason?: string;
  /** The arithmetic, in the terms a reader would ask about. */
  detail: Record<string, number | string>;
}

/**
 * What a snapshot captures for audit.
 *
 * Identifiers and weights — never the raw provider payload. The payload is already retained on the
 * signal row as evidence; copying it into every score snapshot would multiply the largest column in
 * the schema by the number of times anything was scored, to store a second copy of something one
 * join away.
 */
export interface ScoreAudit {
  scorerVersion: string;
  evaluatedAt: string;
  signalKeys: string[];
  domainRanking: { riskDomain: string; strength: number }[];
}

export interface ScoreResult {
  /** 0–100, rounded to two decimals so a persisted numeric(6,2) round-trips exactly. */
  score: number;
  band: ScoreBand;
  components: ScoreComponent[];
  /** The points that CAN be earned given what is known. 65 until the catalog lands. */
  reachableMax: number;
  scorerVersion: string;
  audit: ScoreAudit;
}

/** Clamp into [0,1]. A feed that reports 1.4 is wrong, not extraordinarily severe. */
function unitClamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Exponential decay by exact age, floored.
 *
 * A future publication date scores as fully fresh rather than above 1: a feed with a bad clock
 * should not be able to inflate a score above what a perfect signal earns.
 */
export function freshnessFactor(publishedAt: string, evaluatedAt: string): number {
  const published = Date.parse(publishedAt);
  const evaluated = Date.parse(evaluatedAt);
  // An unparseable date is treated as maximally aged rather than as an error: one bad row must not
  // take down the scoring of every other signal in the poll, and the floor keeps it contributing.
  if (Number.isNaN(published) || Number.isNaN(evaluated)) return FRESHNESS_FLOOR;
  const ageDays = Math.max(0, (evaluated - published) / 86_400_000);
  const decayed = Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
  return Math.max(FRESHNESS_FLOOR, decayed);
}

/** One signal's contribution, in [0,1]. */
function signalStrength(signal: ScorableSignal, evaluatedAt: string): number {
  const base = unitClamp(signal.severityScore) * unitClamp(signal.confidence);
  const fresh = freshnessFactor(signal.publishedAt, evaluatedAt);
  const resolved = signal.sourceResolved ? SOURCE_RESOLVED_FACTOR : 1;
  return unitClamp(base * fresh * resolved);
}

/**
 * Combine several signals within one risk domain.
 *
 * `1 - Π(1 - sᵢ)` — the probabilistic OR. Chosen over a sum because it is bounded by 1 (so no
 * number of weak signals can outrank one severe one) and, crucially, it is monotone
 * NON-DECREASING in every term: adding a signal multiplies the product by `(1 - s)` ≤ 1, so the
 * result can only rise. That is the monotonicity guarantee, as arithmetic rather than as a promise.
 */
function combineWithinDomain(strengths: number[]): number {
  return 1 - strengths.reduce((product, s) => product * (1 - unitClamp(s)), 1);
}

/**
 * The signal-exposure component (65 points).
 *
 * Domains are ranked by strength and paid at shrinking weights, so a second domain adds less than
 * the first and a third would add less again. Ranking rather than a per-domain constant is what
 * keeps the total monotone: a newly matched domain always lands at some rank with a positive
 * weight, and every domain already present keeps a weight at least as large as the one it had.
 */
function scoreSignalExposure(
  signals: ScorableSignal[],
  evaluatedAt: string,
): {
  component: ScoreComponent;
  ranking: { riskDomain: string; strength: number }[];
} {
  const byDomain = new Map<string, number[]>();
  for (const signal of signals) {
    const list = byDomain.get(signal.riskDomain);
    const strength = signalStrength(signal, evaluatedAt);
    if (list) list.push(strength);
    else byDomain.set(signal.riskDomain, [strength]);
  }

  const ranking = [...byDomain.entries()]
    .map(([riskDomain, strengths]) => ({
      riskDomain,
      strength: combineWithinDomain(strengths),
    }))
    // Strength first, then the domain name by CODE POINT — so two domains of equal strength always
    // rank the same way and the score does not depend on Map insertion order. Deliberately not
    // `localeCompare`: its result depends on the runtime's ICU data and the ambient locale, so the
    // same input could rank differently on two machines, which is exactly the non-determinism this
    // scorer exists to avoid.
    .sort((a, b) => b.strength - a.strength || (a.riskDomain < b.riskDomain ? -1 : 1));

  let weighted = 0;
  ranking.forEach((entry, rank) => {
    // A domain beyond the table is weighted by continuing the halving, never by zero: a feed that
    // invents a domain must not break the poll, and must not silently contribute nothing either.
    weighted += entry.strength * domainRankWeight(rank);
  });

  const points = round2(
    (weighted / domainWeightTotal(ranking.length)) * COMPONENT_BUDGET.signalExposure,
  );
  return {
    ranking,
    component: {
      name: "signalExposure",
      points,
      max: COMPONENT_BUDGET.signalExposure,
      available: true,
      detail: {
        signals: signals.length,
        domains: ranking.length,
        strongestDomain: ranking[0]?.riskDomain ?? "none",
        weightedStrength: round2(weighted),
      },
    },
  };
}

/**
 * Days on hand (20 points) — dormant until the catalog slice lands.
 *
 * Fewer days remaining is more exposure, linearly down to zero at `FULL_EXPOSURE_DAYS` and no
 * exposure at or beyond `NO_EXPOSURE_DAYS`.
 */
export const FULL_EXPOSURE_DAYS = 3;
export const NO_EXPOSURE_DAYS = 60;

function scoreDaysOnHand(catalog: CatalogExposure | undefined): ScoreComponent {
  const days = catalog?.daysOnHand;
  if (days === undefined || !Number.isFinite(days)) {
    return {
      name: "daysOnHand",
      points: 0,
      max: COMPONENT_BUDGET.daysOnHand,
      available: false,
      unavailableReason:
        "no days-on-hand figure — this facility has no stock count, or no purchasing history to " +
        "read a burn rate from, for the matched items",
      detail: {},
    };
  }
  const clamped = Math.max(FULL_EXPOSURE_DAYS, Math.min(NO_EXPOSURE_DAYS, days));
  const exposure = (NO_EXPOSURE_DAYS - clamped) / (NO_EXPOSURE_DAYS - FULL_EXPOSURE_DAYS);
  return {
    name: "daysOnHand",
    points: round2(exposure * COMPONENT_BUDGET.daysOnHand),
    max: COMPONENT_BUDGET.daysOnHand,
    available: true,
    detail: { daysOnHand: days, exposure: round2(exposure) },
  };
}

/** Sole-source exposure (15 points) — dormant until supplier data lands. */
function scoreSoleSource(catalog: CatalogExposure | undefined): ScoreComponent {
  const sites = catalog?.supplierSiteCount;
  if (sites === undefined || !Number.isFinite(sites)) {
    return {
      name: "soleSource",
      points: 0,
      max: COMPONENT_BUDGET.soleSource,
      available: false,
      unavailableReason: "no supplier links recorded for the matched items",
      detail: {},
    };
  }
  // One site is full exposure; each additional site halves it, never reaching zero — a second
  // supplier is a real mitigation, and a fourth is barely a further one.
  const exposure = sites <= 1 ? 1 : Math.pow(0.5, sites - 1);
  return {
    name: "soleSource",
    points: round2(exposure * COMPONENT_BUDGET.soleSource),
    max: COMPONENT_BUDGET.soleSource,
    available: true,
    detail: {
      supplierSiteCount: sites,
      exposure: round2(exposure),
      ...(catalog?.soleSourcedItemIds?.length
        ? { soleSourcedItems: catalog.soleSourcedItemIds.join(", ") }
        : {}),
    },
  };
}

/**
 * Read the band off the score, as a fraction of what that score could have reached.
 *
 * `reachableMax` of 0 (nothing is computable at all) bands as `low` rather than dividing by zero —
 * no basis for a reading is not the same as a high reading.
 */
export function bandFor(score: number, reachableMax: number): ScoreBand {
  if (!Number.isFinite(score) || !Number.isFinite(reachableMax) || reachableMax <= 0) return "low";
  const fraction = score / reachableMax;
  // Walk high to low so the first threshold met wins.
  for (const band of [...SCORE_BANDS].reverse()) {
    if (fraction >= BAND_THRESHOLDS[band]) return band;
  }
  return "low";
}

/**
 * Score one item's exposure.
 *
 * Total is the SUM of available components. An unavailable component contributes 0 points and is
 * reported as unavailable, so the console can say "65 of 100 reachable" instead of implying the
 * facility scored zero on stock it has never been told about.
 */
export function scoreSignals(input: ScoreInput): ScoreResult {
  const exposure = scoreSignalExposure(input.signals, input.evaluatedAt);
  const components = [
    exposure.component,
    scoreDaysOnHand(input.catalog),
    scoreSoleSource(input.catalog),
  ];
  const score = round2(components.reduce((total, c) => total + c.points, 0));
  const reachableMax = components.filter((c) => c.available).reduce((total, c) => total + c.max, 0);
  return {
    score,
    band: bandFor(score, reachableMax),
    components,
    reachableMax,
    scorerVersion: SCORER_VERSION,
    audit: {
      scorerVersion: SCORER_VERSION,
      evaluatedAt: input.evaluatedAt,
      // SORTED, by code point. Two callers holding the same set of signals in different array
      // orders describe the same exposure, and an audit record that differs between them is one
      // that cannot be compared — which is the whole point of recording it. Deliberately not
      // `localeCompare`, for the reason stated at the domain ranking above.
      signalKeys: [...input.signals.map((s) => s.dedupeKey)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      domainRanking: exposure.ranking.map((r) => ({
        riskDomain: r.riskDomain,
        strength: round2(r.strength),
      })),
    },
  };
}

/** What one component looks like in a persisted snapshot. */
export interface PersistedComponent {
  points: number;
  max: number;
  available: boolean;
  unavailableReason?: string;
}

/**
 * The component breakdown as a snapshot row stores it.
 *
 * Keeps `available` and its reason, because a bare number cannot tell "this facility has plenty of
 * stock" from "nobody has told us what this facility stocks" — and a console reading the second as
 * the first is making a claim the system has no basis for. Storing only points would put that
 * ambiguity into every row the poll writes.
 */
export function componentsToRecord(result: ScoreResult): Record<string, PersistedComponent> {
  return Object.fromEntries(
    result.components.map((c) => [
      c.name,
      {
        points: c.points,
        max: c.max,
        available: c.available,
        ...(c.unavailableReason ? { unavailableReason: c.unavailableReason } : {}),
      },
    ]),
  );
}
