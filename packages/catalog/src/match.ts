import { DEFAULT_SIGNAL_CONFIDENCE } from "@stopgap/ingest";
import type { IdentifierType } from "./rows.js";

/**
 * Matching a signal to the items a facility actually stocks (ticket 16).
 *
 * PURE. The database finds candidate rows; this decides which of them the signal is about, and how
 * sure that is. Keeping the judgement out of the query is what makes it testable without Postgres
 * and what stops "how a match is decided" from being spread across a `where` clause.
 */

/**
 * Identifier types a signal's match hints can carry, in the order they are trusted.
 *
 * NDC and RxCUI only. `gtin`, `hibc` and `sku` exist in the catalog vocabulary but no feed emits
 * them, so accepting them here would advertise a matching route that never fires — and a route
 * that never fires is a route nobody notices is broken.
 */
export const MATCHABLE_IDENTIFIER_TYPES = ["ndc", "rxcui"] as const satisfies readonly IdentifierType[];

export type MatchableIdentifierType = (typeof MATCHABLE_IDENTIFIER_TYPES)[number];

/** What the signal knows about the thing at risk. The contract's `MatchHints` shape (ticket 05). */
export interface SignalMatchHints {
  ndcs: string[];
  rxcuis: string[];
  names: string[];
}

/** One catalog item, with everything matching is allowed to look at. */
export interface MatchCandidate {
  itemId: string;
  /** This item's identifiers, as stored. */
  identifiers: { type: string; value: string }[];
  /** The facility's own name for the item. */
  name: string;
  /** The generic name, when the facility recorded one. */
  genericName?: string | null;
}

export interface SignalMatch {
  itemId: string;
  /** `identifier` is an exact code match; `name` is the fallback. */
  basis: "identifier" | "name";
  /** Which identifier type matched, for an `identifier` basis. */
  identifierType?: MatchableIdentifierType;
  /**
   * How much this match is worth, [0,1].
   *
   * An identifier match is 1: an NDC is the same code on both sides, and there is no judgement
   * left to discount. A NAME match takes `DEFAULT_SIGNAL_CONFIDENCE` — the SAME constant the
   * signal contract stamps on a signal and the scorer then multiplies through, imported rather
   * than copied. The spec calls that coupling load-bearing and it is: two copies drift, and a
   * drift between "how confident is this match" and "how confident is this signal" produces
   * numbers that are plausible and wrong, which is the hardest class of bug to notice because
   * nothing errors.
   */
  confidence: number;
}

/**
 * Codes differ only by punctuation and case across feeds; the comparison should not.
 *
 * EXPORTED because the SQL that narrows candidates has to normalize the STORED side identically.
 * A query stricter than this function silently drops rows the matcher would have accepted, and the
 * failure is invisible: no error, just a shortage that never matched the item on the shelf.
 */
export function normalizeCode(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "").toLowerCase();
}

/** Names differ by whitespace and case; collapse both, on BOTH sides. Exported for the same reason. */
export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Which items this signal is about.
 *
 * Identifier matches win outright: if any code lines up, the name fallback is not consulted at all
 * for that item. A name is how you find the right item when nobody published a code, not a
 * second opinion on an item a code already identified — running both would let a loose name match
 * add a duplicate row for an item already matched exactly.
 *
 * Returns at most one match per item, highest basis first, in a deterministic order — two runs
 * over the same catalog must produce the same list, or a score becomes irreproducible.
 */
export function matchSignalToItems(
  hints: SignalMatchHints,
  candidates: MatchCandidate[],
): SignalMatch[] {
  const wanted = new Map<MatchableIdentifierType, Set<string>>([
    ["ndc", new Set(hints.ndcs.map(normalizeCode).filter(Boolean))],
    ["rxcui", new Set(hints.rxcuis.map(normalizeCode).filter(Boolean))],
  ]);
  const wantedNames = new Set(hints.names.map(normalizeName).filter(Boolean));

  const matches: SignalMatch[] = [];
  for (const candidate of candidates) {
    let identifierHit: MatchableIdentifierType | undefined;
    for (const identifier of candidate.identifiers) {
      const type = MATCHABLE_IDENTIFIER_TYPES.find((t) => t === identifier.type);
      if (!type) continue;
      if (wanted.get(type)?.has(normalizeCode(identifier.value))) {
        identifierHit = type;
        break;
      }
    }
    if (identifierHit) {
      matches.push({
        itemId: candidate.itemId,
        basis: "identifier",
        identifierType: identifierHit,
        confidence: 1,
      });
      continue;
    }
    const names = [candidate.name, candidate.genericName ?? ""].map(normalizeName).filter(Boolean);
    if (names.some((n) => wantedNames.has(n))) {
      matches.push({ itemId: candidate.itemId, basis: "name", confidence: DEFAULT_SIGNAL_CONFIDENCE });
    }
  }

  // Identifier matches first, then by item id — a stable order, so the same catalog scores the
  // same way twice.
  return matches.sort((a, b) => {
    if (a.basis !== b.basis) return a.basis === "identifier" ? -1 : 1;
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
  });
}
