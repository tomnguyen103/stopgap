import { GOLDEN_DATASET } from "@stopgap/agents";
import type { Severity, ShortageRecord } from "@stopgap/core";

/**
 * Replay corpus (PROJECT_PLAN §3A). Each entry is a shortage record plus the simulated
 * pharmacist decision used as ground truth.
 *
 * The corpus is derived from the golden dataset rather than duplicated: those cases already
 * carry human-reviewed labels, and keeping one labeled corpus means a label correction fixes
 * both the eval gate and the shadow baseline. The severity baseline is the labeled floor —
 * the rung a pharmacist would not go below — so "agreed" means the agent landed exactly
 * where the human would have, and landing above the floor still counts as a disagreement
 * here even though the eval gate tolerates it. Shadow mode is measuring how closely the
 * agent tracks a human, not whether it stayed safe.
 */
export interface ReplayEntry {
  id: string;
  record: ShortageRecord;
  /** Drug class the promotion gates aggregate by. Derived, see `drugClassFor`. */
  drugClass: string;
  baseline: { severity: Severity; hasAlternative: boolean };
}

/**
 * Coarse therapeutic grouping used by the promotion gates. RxNorm class lookup exists in
 * `@stopgap/ingest`, but it needs an RxCUI and most corpus entries have none — so entries
 * are grouped by dosage form/route keywords, which is the axis a pharmacy P&T committee
 * would actually promote along (injectables before orals, and so on).
 */
export function drugClassFor(record: ShortageRecord): string {
  const name = record.genericName.toLowerCase();
  if (/(immune globulin|albumin|antihemophilic|immune fab|antitoxin|asparaginase|epoetin)/.test(name)) {
    return "biologic";
  }
  if (/(cisplatin|carboplatin|methotrexate|vincristine|fluorouracil|doxorubicin|leucovorin)/.test(name)) {
    return "oncology";
  }
  if (/(injection|injectable|for injection|syringe|emulsion)/.test(name)) return "injectable";
  if (/(tablet|capsule|suspension|solution|inhalation)/.test(name)) return "oral-inhaled";
  return "other";
}

export const REPLAY_CORPUS: ReplayEntry[] = GOLDEN_DATASET.map((goldenCase) => ({
  id: goldenCase.id,
  record: goldenCase.record,
  drugClass: drugClassFor(goldenCase.record),
  baseline: {
    severity: goldenCase.expected.severityAtLeast,
    hasAlternative: goldenCase.expected.hasAlternative,
  },
}));
