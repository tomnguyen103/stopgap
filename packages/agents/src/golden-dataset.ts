import type { ShortageRecord } from "@stopgap/core";

/**
 * Golden dataset (PROJECT_PLAN §8: "golden dataset ~60-100 historical shortage cases with
 * labeled expected actions"). Each entry is a shortage record with human-reviewed expected
 * bounds on what the agents should conclude.
 *
 * **What these records are.** They are realistic reconstructions, not verbatim feed rows:
 * the drugs, shortage patterns and clinical substitution facts are real (all of these have
 * appeared on FDA/ASHP shortage lists), while NDC digits are synthetic — the agents only use
 * NDC *count* as a breadth signal, never the digits themselves, so synthetic codes exercise
 * the same behaviour without implying a specific manufacturer was in shortage on a date.
 *
 * **Labeling rubric** (why each case gets the bounds it gets):
 * - `severityAtLeast` — the floor a competent pharmacist would not go below. Life-support,
 *   code-cart and curative-oncology drugs floor at `high`; ward staples with easy substitutes
 *   floor at `low`/`moderate`; anything already `resolved` floors at `none`.
 * - `severityAtMost` — set only where over-escalation is the failure being tested (resolved
 *   shortages, single-manufacturer blips with abundant equivalents). Over-escalation wastes
 *   pharmacist time; under-escalation is the dangerous direction, so most cases only floor.
 * - `hasAlternative` — false only for drugs with genuinely no therapeutic equivalent:
 *   plasma-derived products, specific antidotes/antivenoms, and agents whose "substitute"
 *   would be a different treatment decision rather than a substitution.
 */
export interface GoldenCase {
  id: string;
  record: ShortageRecord;
  expected: {
    /** Severity should land at or above this rung (agents may reasonably disagree within-bucket). */
    severityAtLeast: "none" | "low" | "moderate" | "high" | "critical";
    /**
     * Severity should land at or below this rung. Optional — most cases only need a floor;
     * set this when over-escalation itself is the failure mode being tested (e.g. a resolved
     * shortage that should NOT come back as "critical").
     */
    severityAtMost?: "none" | "low" | "moderate" | "high" | "critical";
    /** True if a real therapeutic alternative is expected to exist. */
    hasAlternative: boolean;
  };
}

const SEVERITY_RANK = ["none", "low", "moderate", "high", "critical"] as const;
type SeverityRank = (typeof SEVERITY_RANK)[number];

export function severityMeetsFloor(actual: string, floor: string): boolean {
  return SEVERITY_RANK.indexOf(actual as SeverityRank) >= SEVERITY_RANK.indexOf(floor as SeverityRank);
}

export function severityWithinCeiling(actual: string, ceiling: string): boolean {
  return SEVERITY_RANK.indexOf(actual as SeverityRank) <= SEVERITY_RANK.indexOf(ceiling as SeverityRank);
}

interface CaseSpec {
  id: string;
  /** Generic drug name as a feed would render it. */
  generic: string;
  /** How many affected NDCs the feed reports — the agents' main breadth signal. */
  ndcCount: number;
  note: string;
  floor: SeverityRank;
  ceiling?: SeverityRank;
  hasAlternative: boolean;
  status?: ShortageRecord["status"];
  source?: ShortageRecord["source"];
  rxcui?: string;
}

/**
 * Synthetic-but-plausible NDC digits, derived from the case id so the dataset is stable
 * across runs (randomized fixtures would make an eval failure impossible to reproduce).
 */
function syntheticNdcs(id: string, count: number): string[] {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
  return Array.from({ length: count }, (_unused, index) => {
    const labeler = String((hash + index * 7) % 10_000).padStart(4, "0");
    const product = String((hash + index * 13) % 10_000).padStart(4, "0");
    return `${labeler}-${product}-0${(index % 9) + 1}`;
  });
}

function toGoldenCase(spec: CaseSpec): GoldenCase {
  return {
    id: spec.id,
    record: {
      source: spec.source ?? "openfda",
      sourceId: spec.id,
      key: spec.generic.toLowerCase(),
      genericName: spec.generic,
      status: spec.status ?? "current",
      ndcs: syntheticNdcs(spec.id, spec.ndcCount),
      rxcuis: spec.rxcui ? [spec.rxcui] : [],
      note: spec.note,
    },
    expected: {
      severityAtLeast: spec.floor,
      ...(spec.ceiling ? { severityAtMost: spec.ceiling } : {}),
      hasAlternative: spec.hasAlternative,
    },
  };
}

const SPECS: CaseSpec[] = [
  // --- Critical-care / code-cart drugs: no ward workaround, floor high ------------------
  { id: "heparin-multi-ndc", generic: "Heparin Sodium Injection", ndcCount: 4, rxcui: "1658690", note: "Manufacturing delay across multiple presentations, no restock date.", floor: "high", hasAlternative: true },
  { id: "epinephrine-code-cart", generic: "Epinephrine Injection 1 mg/10 mL Syringe", ndcCount: 3, note: "Prefilled code-cart syringes on allocation; vials intermittently available.", floor: "high", hasAlternative: true },
  { id: "norepinephrine-pressor", generic: "Norepinephrine Bitartrate Injection", ndcCount: 3, note: "Primary vasopressor for septic shock; two manufacturers on allocation.", floor: "high", hasAlternative: true },
  { id: "vasopressin-icu", generic: "Vasopressin Injection", ndcCount: 2, note: "Second-line vasopressor supply constrained.", floor: "moderate", hasAlternative: true },
  { id: "atropine-syringe", generic: "Atropine Sulfate Injection Prefilled Syringe", ndcCount: 2, note: "ACLS bradycardia agent, prefilled syringe supply interrupted.", floor: "moderate", hasAlternative: true },
  { id: "amiodarone-iv", generic: "Amiodarone Hydrochloride Injection", ndcCount: 3, note: "Antiarrhythmic supply constrained at multiple labelers.", floor: "moderate", hasAlternative: true },
  { id: "adenosine-iv", generic: "Adenosine Injection", ndcCount: 2, note: "SVT first-line agent, intermittent supply.", floor: "moderate", hasAlternative: true },
  { id: "sodium-bicarb-syringe", generic: "Sodium Bicarbonate Injection Prefilled Syringe", ndcCount: 4, note: "Code-cart syringes back-ordered industry-wide.", floor: "high", hasAlternative: true },
  { id: "calcium-gluconate", generic: "Calcium Gluconate Injection", ndcCount: 3, note: "Hyperkalemia and hypocalcemia treatment on allocation.", floor: "moderate", hasAlternative: true },
  { id: "dextrose-50", generic: "Dextrose 50% Injection Prefilled Syringe", ndcCount: 2, note: "Hypoglycemia rescue syringes constrained.", floor: "moderate", hasAlternative: true },
  { id: "naloxone-injection", generic: "Naloxone Hydrochloride Injection", ndcCount: 3, note: "Opioid reversal agent; injectable presentations constrained.", floor: "high", hasAlternative: true },
  { id: "lidocaine-cardiac", generic: "Lidocaine Hydrochloride Injection", ndcCount: 3, note: "Cardiac and local-anesthetic presentations both affected.", floor: "moderate", hasAlternative: true },

  // --- Anesthesia / procedural: substitutable, but a shortage blocks the OR schedule ----
  { id: "propofol-anesthesia", generic: "Propofol Injectable Emulsion", ndcCount: 4, note: "Induction agent on allocation; OR schedule at risk.", floor: "high", hasAlternative: true },
  { id: "succinylcholine-rsi", generic: "Succinylcholine Chloride Injection", ndcCount: 2, note: "Rapid-sequence-intubation paralytic, cold-chain supply interrupted.", floor: "high", hasAlternative: true },
  { id: "rocuronium-paralytic", generic: "Rocuronium Bromide Injection", ndcCount: 3, note: "Non-depolarizing paralytic supply constrained.", floor: "moderate", hasAlternative: true },
  { id: "ketamine-injection", generic: "Ketamine Hydrochloride Injection", ndcCount: 2, note: "Procedural sedation supply intermittent.", floor: "moderate", hasAlternative: true },
  { id: "etomidate-induction", generic: "Etomidate Injection", ndcCount: 2, note: "Induction agent constrained at primary manufacturer.", floor: "moderate", hasAlternative: true },
  { id: "bupivacaine-regional", generic: "Bupivacaine Hydrochloride Injection", ndcCount: 3, note: "Regional-block anesthetic on back-order.", floor: "moderate", hasAlternative: true },
  { id: "neostigmine-reversal", generic: "Neostigmine Methylsulfate Injection", ndcCount: 2, note: "Neuromuscular-blockade reversal agent constrained.", floor: "moderate", hasAlternative: true },

  // --- Oncology: curative intent, substitution often clinically unacceptable ------------
  { id: "cisplatin-oncology", generic: "Cisplatin Injection", ndcCount: 3, note: "Curative-intent chemotherapy; sterile-injectable plant shutdown.", floor: "high", hasAlternative: true },
  { id: "carboplatin-oncology", generic: "Carboplatin Injection", ndcCount: 3, note: "Platinum agent shortage concurrent with cisplatin constraints.", floor: "high", hasAlternative: true },
  { id: "methotrexate-preservative-free", generic: "Methotrexate Injection, Preservative-Free", ndcCount: 2, note: "Intrathecal-grade product; pediatric ALL protocols affected.", floor: "high", hasAlternative: false },
  { id: "vincristine-oncology", generic: "Vincristine Sulfate Injection", ndcCount: 2, note: "Sole-source pediatric oncology agent; supply interrupted.", floor: "high", hasAlternative: false },
  { id: "fluorouracil-oncology", generic: "Fluorouracil Injection", ndcCount: 3, note: "Colorectal regimens affected by fill-finish capacity loss.", floor: "high", hasAlternative: true },
  { id: "doxorubicin-oncology", generic: "Doxorubicin Hydrochloride Injection", ndcCount: 2, note: "Anthracycline supply constrained.", floor: "high", hasAlternative: true },
  { id: "leucovorin-rescue", generic: "Leucovorin Calcium Injection", ndcCount: 2, note: "Methotrexate rescue agent constrained — no in-protocol rescue alternative.", floor: "high", hasAlternative: false },
  { id: "asparaginase-pediatric", generic: "Asparaginase Erwinia chrysanthemi", ndcCount: 1, note: "Biologic for ALL patients hypersensitive to E. coli asparaginase.", floor: "high", hasAlternative: false },

  // --- Plasma-derived and biologic: genuinely no therapeutic equivalent -----------------
  { id: "immune-globulin-no-equivalent", generic: "Immune Globulin (Human)", ndcCount: 1, source: "ashp", note: "Plasma-derived product, industry-wide shortage.", floor: "moderate", hasAlternative: false },
  { id: "albumin-human", generic: "Albumin (Human) 25%", ndcCount: 2, source: "ashp", note: "Plasma-derived volume expander; donor-plasma collection shortfall.", floor: "moderate", hasAlternative: false },
  { id: "rho-d-immune-globulin", generic: "Rho(D) Immune Globulin", ndcCount: 1, source: "ashp", note: "Obstetric alloimmunization prophylaxis; plasma-derived.", floor: "high", hasAlternative: false },
  { id: "factor-viii-concentrate", generic: "Antihemophilic Factor (Recombinant)", ndcCount: 1, source: "ashp", note: "Hemophilia A factor concentrate; manufacturing capacity constrained.", floor: "high", hasAlternative: false },
  { id: "digoxin-immune-fab", generic: "Digoxin Immune Fab (Ovine)", ndcCount: 1, note: "Specific digoxin antidote; no alternative reversal agent exists.", floor: "high", hasAlternative: false },
  { id: "crotalidae-antivenom", generic: "Crotalidae Polyvalent Immune Fab", ndcCount: 1, note: "Pit-viper envenomation antivenom on allocation.", floor: "high", hasAlternative: false },
  { id: "botulism-antitoxin", generic: "Botulism Antitoxin Heptavalent", ndcCount: 1, note: "Strategic-stockpile antitoxin; no substitute product.", floor: "high", hasAlternative: false },
  { id: "tuberculin-ppd", generic: "Tuberculin Purified Protein Derivative", ndcCount: 1, note: "TB screening antigen supply interrupted.", floor: "low", hasAlternative: true },

  // --- Anti-infectives: substitutable, but stewardship pressure -------------------------
  { id: "cefazolin-surgical", generic: "Cefazolin Injection", ndcCount: 4, note: "Surgical-prophylaxis workhorse; multiple labelers affected.", floor: "high", hasAlternative: true },
  { id: "piperacillin-tazobactam", generic: "Piperacillin and Tazobactam Injection", ndcCount: 3, note: "Broad-spectrum empiric therapy constrained.", floor: "moderate", hasAlternative: true },
  { id: "vancomycin-iv", generic: "Vancomycin Hydrochloride Injection", ndcCount: 3, note: "MRSA-coverage mainstay; premixed bags affected.", floor: "moderate", hasAlternative: true },
  { id: "ceftriaxone-iv", generic: "Ceftriaxone Sodium Injection", ndcCount: 3, note: "Common empiric agent on intermittent back-order.", floor: "moderate", hasAlternative: true },
  { id: "meropenem-iv", generic: "Meropenem Injection", ndcCount: 2, note: "Carbapenem supply constrained at one manufacturer.", floor: "moderate", hasAlternative: true },
  { id: "ampicillin-iv", generic: "Ampicillin for Injection", ndcCount: 2, note: "Neonatal sepsis regimens affected.", floor: "moderate", hasAlternative: true },
  { id: "gentamicin-iv", generic: "Gentamicin Sulfate Injection", ndcCount: 2, note: "Aminoglycoside supply interrupted.", floor: "low", hasAlternative: true },
  { id: "amoxicillin-oral-suspension", generic: "Amoxicillin Oral Suspension", ndcCount: 4, note: "Pediatric oral suspension demand spike during respiratory season.", floor: "moderate", hasAlternative: true },
  { id: "acyclovir-iv", generic: "Acyclovir Sodium Injection", ndcCount: 2, note: "HSV encephalitis therapy constrained.", floor: "moderate", hasAlternative: true },
  { id: "fluconazole-iv", generic: "Fluconazole Injection", ndcCount: 2, note: "Antifungal premix bags back-ordered.", floor: "low", hasAlternative: true },
  { id: "isoniazid-tablets", generic: "Isoniazid Tablets", ndcCount: 2, note: "TB regimen component; no equivalent substitution within the regimen.", floor: "moderate", hasAlternative: false },

  // --- Fluids, electrolytes and diluents: breadth makes these hospital-wide -------------
  { id: "sodium-chloride-iv-bags", generic: "Sodium Chloride 0.9% Injection Bags", ndcCount: 6, note: "Hurricane damage to a major fluid plant; hospital-wide impact.", floor: "high", hasAlternative: true },
  { id: "lactated-ringers", generic: "Lactated Ringer's Injection", ndcCount: 4, note: "Crystalloid supply constrained alongside saline.", floor: "high", hasAlternative: true },
  { id: "sterile-water-injection", generic: "Sterile Water for Injection", ndcCount: 4, note: "Diluent shortage affects compounding across the formulary.", floor: "high", hasAlternative: false },
  { id: "potassium-chloride-premix", generic: "Potassium Chloride Injection Premix", ndcCount: 3, note: "Premixed bags constrained; compounding capacity limited.", floor: "moderate", hasAlternative: true },
  { id: "magnesium-sulfate-iv", generic: "Magnesium Sulfate Injection", ndcCount: 3, note: "Obstetric eclampsia prophylaxis and repletion affected.", floor: "moderate", hasAlternative: true },
  { id: "sodium-phosphate-injection", generic: "Sodium Phosphates Injection", ndcCount: 2, note: "Parenteral-nutrition component on allocation.", floor: "moderate", hasAlternative: true },
  { id: "trace-elements-tpn", generic: "Trace Elements Injection", ndcCount: 2, note: "Parenteral-nutrition additive constrained.", floor: "moderate", hasAlternative: true },
  { id: "dextrose-70-tpn", generic: "Dextrose 70% Injection Pharmacy Bulk", ndcCount: 2, note: "Parenteral-nutrition base solution supply interrupted.", floor: "moderate", hasAlternative: true },

  // --- Ward staples with abundant substitutes: over-escalation guards -------------------
  { id: "single-ndc-minor", generic: "Ondansetron Injection", ndcCount: 1, rxcui: "312938", note: "One manufacturer's supply intermittently constrained; others available.", floor: "low", hasAlternative: true },
  { id: "famotidine-injection", generic: "Famotidine Injection", ndcCount: 1, note: "Single labeler constrained; oral and alternative IV agents available.", floor: "low", ceiling: "moderate", hasAlternative: true },
  { id: "metoclopramide-injection", generic: "Metoclopramide Injection", ndcCount: 1, note: "One presentation short; other antiemetics stocked.", floor: "low", ceiling: "moderate", hasAlternative: true },
  { id: "pantoprazole-iv", generic: "Pantoprazole Sodium for Injection", ndcCount: 2, note: "IV proton-pump inhibitor constrained; oral route fine for most patients.", floor: "low", ceiling: "high", hasAlternative: true },
  { id: "diphenhydramine-injection", generic: "Diphenhydramine Hydrochloride Injection", ndcCount: 1, note: "Single-labeler interruption; oral and alternative antihistamines available.", floor: "low", ceiling: "moderate", hasAlternative: true },
  { id: "acetaminophen-iv", generic: "Acetaminophen Injection", ndcCount: 1, note: "IV formulation constrained; oral and rectal routes available.", floor: "low", ceiling: "moderate", hasAlternative: true },
  { id: "dexamethasone-injection", generic: "Dexamethasone Sodium Phosphate Injection", ndcCount: 2, note: "Corticosteroid supply intermittent; equivalent steroids stocked.", floor: "low", hasAlternative: true },
  { id: "hydrocortisone-injection", generic: "Hydrocortisone Sodium Succinate for Injection", ndcCount: 2, note: "Adrenal-crisis steroid constrained; alternative steroids available.", floor: "moderate", hasAlternative: true },
  { id: "furosemide-injection", generic: "Furosemide Injection", ndcCount: 2, note: "Loop diuretic supply interrupted at two labelers.", floor: "low", hasAlternative: true },
  { id: "labetalol-injection", generic: "Labetalol Hydrochloride Injection", ndcCount: 2, note: "IV antihypertensive constrained.", floor: "low", hasAlternative: true },

  // --- Controlled substances and psychiatry --------------------------------------------
  { id: "hydromorphone-injection", generic: "Hydromorphone Hydrochloride Injection", ndcCount: 3, note: "Quota-constrained opioid; palliative and post-op use affected.", floor: "moderate", hasAlternative: true },
  { id: "morphine-injection", generic: "Morphine Sulfate Injection", ndcCount: 3, note: "Opioid supply constrained alongside hydromorphone.", floor: "moderate", hasAlternative: true },
  { id: "fentanyl-injection", generic: "Fentanyl Citrate Injection", ndcCount: 3, note: "ICU sedation and anesthesia supply constrained.", floor: "high", hasAlternative: true },
  { id: "lorazepam-injection", generic: "Lorazepam Injection", ndcCount: 2, note: "Status-epilepticus first-line agent; cold-chain supply interrupted.", floor: "high", hasAlternative: true },
  { id: "diazepam-injection", generic: "Diazepam Injection", ndcCount: 2, note: "Benzodiazepine supply constrained.", floor: "moderate", hasAlternative: true },
  { id: "haloperidol-injection", generic: "Haloperidol Lactate Injection", ndcCount: 2, note: "Acute-agitation agent supply interrupted.", floor: "low", hasAlternative: true },
  { id: "lithium-carbonate-oral", generic: "Lithium Carbonate Tablets", ndcCount: 2, note: "Narrow-therapeutic-index psychiatric maintenance therapy constrained.", floor: "moderate", hasAlternative: true },
  { id: "clozapine-oral", generic: "Clozapine Tablets", ndcCount: 2, note: "Treatment-resistant schizophrenia; monitored therapy with no direct equivalent.", floor: "high", hasAlternative: false },

  // --- Chronic / outpatient therapies --------------------------------------------------
  // Floor is `moderate`, not `high`: the rapid-acting insulins (lispro/aspart/glulisine) are
  // directly interchangeable at the same dose, so a single-manufacturer constraint is a
  // formulary swap rather than a therapy gap. Label corrected after the first live run.
  { id: "insulin-lispro", generic: "Insulin Lispro Injection", ndcCount: 3, note: "Rapid-acting insulin supply constrained at one manufacturer.", floor: "moderate", hasAlternative: true },
  { id: "levothyroxine-tablets", generic: "Levothyroxine Sodium Tablets", ndcCount: 3, note: "Narrow-therapeutic-index thyroid replacement; strength-specific shortage.", floor: "moderate", hasAlternative: true },
  { id: "albuterol-nebulizer", generic: "Albuterol Sulfate Inhalation Solution", ndcCount: 3, note: "Nebulizer solution demand spike; a major manufacturer ceased production.", floor: "high", hasAlternative: true },
  { id: "enoxaparin-injection", generic: "Enoxaparin Sodium Injection", ndcCount: 2, note: "Low-molecular-weight heparin constrained; monitoring burden if switched.", floor: "moderate", hasAlternative: true },
  { id: "protamine-sulfate", generic: "Protamine Sulfate Injection", ndcCount: 1, note: "Sole heparin reversal agent for cardiac surgery.", floor: "high", hasAlternative: false },
  { id: "phytonadione-injection", generic: "Phytonadione (Vitamin K1) Injection", ndcCount: 2, note: "Warfarin reversal and newborn prophylaxis affected.", floor: "high", hasAlternative: false },
  { id: "thiamine-injection", generic: "Thiamine Hydrochloride Injection", ndcCount: 2, note: "Wernicke prophylaxis in withdrawal patients constrained.", floor: "moderate", hasAlternative: false },
  { id: "iron-sucrose-injection", generic: "Iron Sucrose Injection", ndcCount: 2, note: "IV iron supply interrupted; other IV iron products available.", floor: "low", hasAlternative: true },
  { id: "epoetin-alfa", generic: "Epoetin Alfa Injection", ndcCount: 2, note: "Dialysis anemia therapy constrained; biosimilar supply limited.", floor: "moderate", hasAlternative: true },
  { id: "oxytocin-injection", generic: "Oxytocin Injection", ndcCount: 2, note: "Postpartum-hemorrhage and induction agent supply interrupted.", floor: "high", hasAlternative: true },
  { id: "tranexamic-acid-injection", generic: "Tranexamic Acid Injection", ndcCount: 2, note: "Trauma and obstetric hemorrhage antifibrinolytic constrained.", floor: "moderate", hasAlternative: true },

  // --- Resolved / low-signal: pure over-escalation guards -------------------------------
  { id: "resolved-should-be-low-or-none", generic: "Cefazolin Injection", ndcCount: 1, rxcui: "2180", source: "ashp", status: "resolved", note: "Manufacturer resumed full supply.", floor: "none", ceiling: "low", hasAlternative: false },
  { id: "resolved-saline", generic: "Sodium Chloride 0.9% Injection Bags", ndcCount: 1, source: "ashp", status: "resolved", note: "Plant back online, all presentations available.", floor: "none", ceiling: "low", hasAlternative: false },
  { id: "resolved-ondansetron", generic: "Ondansetron Injection", ndcCount: 1, source: "ashp", status: "resolved", note: "Back-order cleared; normal ordering resumed.", floor: "none", ceiling: "low", hasAlternative: false },
  { id: "discontinued-with-generics", generic: "Ranitidine Injection", ndcCount: 1, status: "resolved", note: "Product withdrawn from market; therapeutic alternatives long since standard.", floor: "none", ceiling: "low", hasAlternative: false },
];

export const GOLDEN_DATASET: GoldenCase[] = SPECS.map(toGoldenCase);

/**
 * The subset `pnpm eval` runs by default. The full corpus is ~85 cases × 2 agents × 3 votes
 * ≈ 500 live local-model calls — an hour-plus on a laptop, too slow to run on every change.
 * Routine runs take a deterministic stride through the list (spread across every category,
 * identical between runs so a failure is reproducible); `pnpm eval:full` runs everything.
 */
export function evalSubset(cases: GoldenCase[] = GOLDEN_DATASET, size = 12): GoldenCase[] {
  if (size >= cases.length) return cases;
  const stride = cases.length / size;
  return Array.from({ length: size }, (_unused, index) => cases[Math.floor(index * stride)]!);
}
