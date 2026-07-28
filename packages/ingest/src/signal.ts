import type { ShortageStatus } from "@stopgap/core";

/**
 * The normalized signal contract (unified-platform-spec, "Ingestion — one connector contract";
 * ticket 05).
 *
 * Every external feed speaks THIS shape and nothing else. Before it, each source had its own
 * structure and every consumer knew about every source, so adding a feed meant editing the
 * consumers. After it, a connector is a pure adapter — fetch, normalize, emit — and the rest of the
 * system has one type to understand.
 *
 * A connector NEVER writes to the database, NEVER scores, and NEVER notifies. Those are three
 * different failure domains (a schema change, a weighting change, a delivery outage) and folding
 * them into the adapter is what makes a feed integration untestable without infrastructure. The
 * normalizers here run against recorded payloads in the offline gate, with no network.
 */

/**
 * The hazard a signal describes. Deliberately short: the product claims shortages and recalls, and
 * the contract's whole point is that adding a domain later is a data change rather than a
 * structural one. The absorbed codebase's geopolitical, seismic, weather, wildfire, sanctions,
 * cyber-vulnerability, chemical-restriction and trade-policy domains are NOT adopted — the contract
 * admits them, the product does not claim them.
 */
export const RISK_DOMAINS = ["shortage", "recall"] as const;
export type RiskDomain = (typeof RISK_DOMAINS)[number];

/** What the signal is about. A recalled infusion pump is not a drug, and ranking must know. */
export const ENTITY_TYPES = ["drug", "device"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Feeds adopted onto the contract. One constant, so a source string cannot be invented inline. */
export const SIGNAL_SOURCES = [
  "openfda_shortage",
  "ashp_shortage",
  "openfda_drug_recall",
  "openfda_device_recall",
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** Ordered least to most severe — the index is the rank, as with roles. */
export const SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * How old the evidence is, as a classification rather than a raw age.
 *
 * The scorer decays by exact age; this exists for the console, where "stale" is a filter a
 * pharmacist applies and a number is not. Both derive from the same timestamps, so they cannot
 * disagree about which is older — only about how coarsely they say it.
 */
export const STALENESS = ["fresh", "aging", "stale"] as const;
export type Staleness = (typeof STALENESS)[number];

/** Day boundaries for the staleness classification. */
export const STALENESS_DAYS = { fresh: 7, aging: 30 } as const;

/**
 * The confidence a signal carries when its source gives no basis for anything else.
 *
 * ONE constant, exported, shared by the scorer and the matching layer. The spec calls this coupling
 * load-bearing and it is: two copies drift, and a drift between "how confident is this signal" in
 * matching versus in scoring produces numbers that are plausible and wrong — the hardest class of
 * bug to notice, because nothing errors.
 *
 * 0.8 rather than 1.0 because a regulator publishing a record is strong evidence about the record,
 * not proof about this facility: the match to a catalog item still has to hold.
 */
export const DEFAULT_SIGNAL_CONFIDENCE = 0.8;

/**
 * What a connector knows that lets a signal be tied to a catalog item later (ticket 16). Hints,
 * not answers — the connector does not query the catalog, because that would make it impure and
 * would put a database in the middle of a normalizer.
 */
export interface MatchHints {
  ndcs: string[];
  rxcuis: string[];
  /** Free-text product and generic names, for fallback matching when no identifier lines up. */
  names: string[];
}

export interface NormalizedSignal {
  source: SignalSource;
  /** The feed's own identifier for this record, as given. Stable across updates to the record. */
  sourceId: string;
  riskDomain: RiskDomain;
  entityType: EntityType;
  /** The thing at risk, in the feed's terms — a generic name, a device description. */
  entityIdentifier: string;
  title: string;
  summary: string;
  severity: Severity;
  /**
   * Severity as a number in [0,1], for the scorer. Carried BESIDE the label rather than derived
   * from it at scoring time, because a feed sometimes knows more than four buckets can express
   * (a recall classification, a shortage's breadth) and flattening early throws that away.
   */
  severityScore: number;
  confidence: number;
  /** When the hazard was observed to exist, per the source. */
  observedAt: string;
  /** When the source published or last updated the record. */
  publishedAt: string;
  /** When this process fetched it. Supplied by the caller, never read from the clock here. */
  lastFetchedAt: string;
  staleness: Staleness;
  /**
   * THE SOURCE considers this hazard over — a terminated recall, a resolved shortage.
   *
   * NOT the same thing as the signal disappearing from the feed, and the spec is emphatic about
   * why. A source-resolved hazard is a WEIGHTING input: the scorer decays it rather than dropping
   * it, because a recall terminated last week still bears on what is safe to substitute into
   * today. A signal that vanished from the feed is a STATUS TRANSITION, reconciled by the poller.
   * Collapsing the two would silently misweight every resolved hazard — and would do it quietly,
   * since both end up "not current".
   */
  sourceResolved: boolean;
  /** Where a human can verify the claim themselves. */
  evidenceUrl: string;
  /** The provider payload, retained as evidence. Never re-parsed for meaning downstream. */
  raw: unknown;
  /**
   * Stable identity, scoped to organization and source.
   *
   * Org-scoped because a signal is the tenant-relevant INTERPRETATION of a global fact: two
   * hospitals reading the same recall have genuinely different signals (spec, "Schema and
   * tenancy"). Source-scoped because two feeds reporting the same hazard are two pieces of
   * evidence, and merging them is a decision for the layer above, not an accident of key
   * collision.
   */
  dedupeKey: string;
  matchHints: MatchHints;
}

/** What a normalizer needs from its caller instead of from ambient state. */
export interface NormalizationContext {
  orgId: string;
  /**
   * The fetch time, passed in. A normalizer that read `Date.now()` would produce a different
   * signal on every call for the same payload, which would break both the determinism the scorer
   * depends on and any test that does not freeze the clock.
   */
  fetchedAt: string;
}

/**
 * A source-agnostic feed adapter. Fetch is impure by nature (network); normalize is pure, and is
 * where every assertion in the offline gate points.
 */
export interface Connector<TRaw> {
  readonly source: SignalSource;
  readonly riskDomain: RiskDomain;
  readonly entityType: EntityType;
  fetch(options?: { limit?: number; fetchImpl?: typeof fetch }): Promise<TRaw[]>;
  normalize(raw: TRaw, context: NormalizationContext): NormalizedSignal;
}

/** The contract's dedupe key, in one place so no connector can spell it differently. */
export function signalDedupeKey(orgId: string, source: SignalSource, sourceId: string): string {
  return `${orgId}:${source}:${sourceId}`;
}

/**
 * Classify freshness from the two timestamps the signal already carries. Pure, and total: an
 * unparseable or future publication date classifies as `stale` rather than throwing, because a
 * feed with a bad date should not take the poll down — and treating unknown age as fresh would be
 * the optimistic direction, which is the wrong one for a hazard.
 */
export function classifyStaleness(publishedAt: string, fetchedAt: string): Staleness {
  const published = Date.parse(publishedAt);
  const fetched = Date.parse(fetchedAt);
  if (Number.isNaN(published) || Number.isNaN(fetched)) return "stale";
  const ageDays = (fetched - published) / 86_400_000;
  if (ageDays < 0) return "stale";
  if (ageDays <= STALENESS_DAYS.fresh) return "fresh";
  if (ageDays <= STALENESS_DAYS.aging) return "aging";
  return "stale";
}

/**
 * The existing shortage status vocabulary, mapped onto the contract's `sourceResolved` flag.
 *
 * `unknown` is NOT resolved. A feed that stopped saying anything definite is not a feed saying the
 * hazard is over, and the conservative reading is the one that keeps the case open.
 */
export function shortageStatusResolved(status: ShortageStatus): boolean {
  return status === "resolved";
}

/**
 * Shortage status mapped onto the contract's severity pair.
 *
 * Shared by every shortage connector rather than duplicated per feed: openFDA and ASHP disagree
 * about wording but not about meaning, and two copies of this table would eventually disagree
 * about meaning too. `unknown` sits ABOVE `resolved` — a feed that went vague is more concerning
 * than a feed that said "over", not less.
 */
export function shortageSeverity(status: ShortageStatus): { severity: Severity; severityScore: number } {
  switch (status) {
    case "current":
      return { severity: "high", severityScore: 0.7 };
    case "resolved":
      return { severity: "low", severityScore: 0.15 };
    default:
      return { severity: "moderate", severityScore: 0.4 };
  }
}
