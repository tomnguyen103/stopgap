/**
 * Compliance guard (unified-platform-spec, "Compliance guard"; ticket 10).
 *
 * The product claims it handles no protected health information and gives no clinical advice.
 * Until now that claim lived in prose. This module makes it enforceable at runtime: generated text
 * is screened before it leaves the system's control — before it renders, and before it is sent —
 * and a violation comes back as a structured report rather than a bare refusal.
 *
 * PURE BY CONSTRUCTION. No network, no database, no framework, no environment. It is a string in
 * and a report out, so every pattern is asserted directly in the offline gate, and the two call
 * sites (render, send) decide what to do about a report rather than having policy decided for them.
 *
 * WHY A REPORT RATHER THAN A BOOLEAN. The guard sits in front of a language model, so it will
 * sometimes be wrong. A boolean makes a false positive indistinguishable from a real violation:
 * the operator sees "blocked", cannot tell which line tripped it, and the pressure is to switch the
 * guard off rather than tune it. Naming the category, the rule and the offending excerpt is what
 * makes a false positive a fixable bug.
 *
 * WHAT IT IS NOT. It is not a redactor and not a certification. It catches the shapes below; text
 * that carries protected information in a form no pattern here anticipates passes. That limit is
 * stated rather than papered over — the boundary is enforced by what the product is allowed to ask
 * a model for in the first place, and this is the last line, not the only one.
 */

/** The categories the spec names. Order is the order a report is grouped and described in. */
export const COMPLIANCE_CATEGORIES = [
  "phi_identifier",
  "records_system_reference",
  "diagnosis_or_treatment",
  "patient_specific",
  "substitution_directive",
] as const;

export type ComplianceCategory = (typeof COMPLIANCE_CATEGORIES)[number];

export interface ComplianceViolation {
  category: ComplianceCategory;
  /** Which rule matched — stable, machine-readable, safe to log. */
  rule: string;
  /** The matched text, bounded. Carries the offending content; see `describeViolations`. */
  excerpt: string;
  /**
   * Offset of the match within the string that was screened — which is the string the CALLER
   * passed, not any field it was assembled from. A caller that concatenates several fields into
   * one screen (as the send boundary does) gets offsets into that concatenation, so it can order
   * and quote the findings but cannot use them to name a field.
   */
  index: number;
}

export interface ComplianceReport {
  ok: boolean;
  /** Every match, ordered by position, so the report reads in the same order as the text. */
  violations: ComplianceViolation[];
}

/**
 * Upper bound on a stored excerpt. An excerpt exists to make a false positive diagnosable, which
 * takes a phrase, not a page — and the excerpt is the one field that by definition contains the
 * content the guard just objected to, so it is the last field that should be unbounded.
 */
const MAX_EXCERPT_LENGTH = 120;

interface Rule {
  category: ComplianceCategory;
  rule: string;
  pattern: RegExp;
}

/**
 * The rule table.
 *
 * Every pattern is `g`-flagged so all occurrences are reported. (`String.prototype.matchAll`
 * requires the flag and iterates over an internal clone, so sharing these across calls does not
 * carry `lastIndex` — the determinism test pins that.)
 *
 * The patterns are deliberately narrow. This guard runs in front of ordinary product prose —
 * "sodium chloride 0.9% 500 mL, NDC 0338-0049-04" — and a rule that fires on any number, any
 * clinical-sounding noun, or any date would make every legitimate protocol a violation. A guard
 * that always fires is a guard somebody switches off, so precision here is a safety property, not
 * a nicety.
 */
const RULES: readonly Rule[] = [
  // --- Protected information ------------------------------------------------------------------
  // Record numbers are matched only with their label attached. A bare alphanumeric run is a lot
  // number, an NDC or a catalogue code far more often than it is a medical record number.
  {
    category: "phi_identifier",
    rule: "medical_record_number",
    // The separator class allows `-` so the hyphenated form (`MRN-4471902`, and identifiers
    // embedded in slugs and keys) is caught, not just `MRN: 4471902`.
    //
    // Each label alternative carries its OWN boundary, and there is none after the alternation:
    // `no.` and `#` end in a non-word character, so a boundary demanded after them can never hold
    // in front of the separator and `Medical Record No. A-99213` would slip past the rule that
    // names it. The boundary sits before the dot in `no\b\.?` rather than after it for the same
    // reason, and it has to be there at all because `no` is a prefix of ordinary words — without
    // it the branch reads "medical record no" out of "medical record notification".
    pattern: /\b(?:MRN\b|medical record (?:number\b|no\b\.?|#))[\s:#-]*[A-Z0-9][A-Z0-9-]{3,}/gi,
  },
  {
    category: "phi_identifier",
    rule: "date_of_birth",
    pattern: /\b(?:DOB|date of birth)\b[\s:]*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/gi,
  },
  // A US national identifier has a shape distinctive enough to match unlabelled; a lot number does
  // not look like this.
  { category: "phi_identifier", rule: "national_identifier", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Punctuated forms only. A space-separated `415 555 0134` is indistinguishable from a lot number
  // or a pack quantity in product prose, and this rule is not worth a false positive on either.
  {
    category: "phi_identifier",
    rule: "phone_number",
    pattern: /(?:\+1[\s-]?)?(?:\(\d{3}\)\s?|\b\d{3}[.-])\d{3}[.-]\d{4}\b/g,
  },
  {
    category: "phi_identifier",
    rule: "email_address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },

  // --- Records-system references --------------------------------------------------------------
  // Naming a records system in generated text means the model believes it is reading or writing
  // one. The product integrates with a formulary webhook and nothing else.
  //
  // Vendor names are matched CASE-SENSITIVELY and the rest case-insensitively, which is not
  // fussiness: "an epic backlog of back-ordered vials" is ordinary supply prose, and a rule that
  // blocks it teaches an operator that the guard is noise.
  {
    category: "records_system_reference",
    rule: "records_system_vendor",
    pattern: /\b(?:Epic|Cerner|Meditech|Allscripts|athenahealth)\b/g,
  },
  {
    category: "records_system_reference",
    rule: "records_system",
    pattern: /\b(?:EHR|EMR|patient chart|chart note)\b/gi,
  },

  // --- Diagnosis and treatment ----------------------------------------------------------------
  //
  // THE HARD PART OF THIS WHOLE MODULE. Label and monograph vocabulary overlaps clinical
  // vocabulary almost completely: "prescribing information", "recommended dosage for adults",
  // "dosing regimen", "titration per USP monograph" and "therapy for the same indication class"
  // are all things a legitimate substitution protocol says, and all things a naive treatment-
  // language rule fires on. Every rule here therefore requires the language to point at a PERSON —
  // a patient, a possessive, a directive — rather than at a product. What is given up is real:
  // clinical advice phrased entirely impersonally passes. That is the deliberate trade, because
  // the alternative is a guard that blocks ordinary protocols and gets switched off within a week.
  {
    category: "diagnosis_or_treatment",
    rule: "diagnosis_language",
    pattern: /\b(?:diagnos(?:is|es|ed|e)|prognosis|comorbidit(?:y|ies))\b/gi,
  },
  {
    category: "diagnosis_or_treatment",
    rule: "treatment_language",
    pattern:
      /\b(?:treatment plan|prescrib(?:e|es|ed|ing)\s+(?:to|for)\s+(?:this|the)\s+patient|titrat(?:e|ing)\s+(?:the|this)\s+patient|(?:dose|dosage|regimen)\s+for\s+(?:this|the)\s+patient)\b/gi,
  },

  // --- Patient-specific phrasing --------------------------------------------------------------
  // "the patient" in the abstract is how clinicians write about product categories, so the rules
  // key on phrasing that points at ONE person: a demonstrative, a possessive, or a bedside.
  {
    category: "patient_specific",
    rule: "patient_reference",
    pattern: /\b(?:this patient|the patient's|patient #?\d+|for the patient in)\b/gi,
  },
  // Anchored on a person, not on a number: a pharmacy has a clean room 3 and a stock cart in
  // bed 12, and neither is protected information.
  {
    category: "patient_specific",
    rule: "bedside_location",
    pattern: /\bpatient\s+(?:in|at)\s+(?:room|bed)\s*#?\d{1,4}\b/gi,
  },

  // --- Substitution directives ----------------------------------------------------------------
  // The product proposes alternatives for a human to approve. Language that instructs an action on
  // a person — rather than describing a product relationship — is the line. Note the absence of a
  // bare "administer": "do not administer past the expiry date" is label text, not a directive.
  {
    category: "substitution_directive",
    rule: "substitution_directive",
    pattern:
      /\b(?:switch the patient to|start the patient on|give the patient|administer\s+(?:it\s+)?to\s+(?:this|the)\s+patient)\b/gi,
  },
];

/** Bound an excerpt without hiding that it was cut. */
function boundExcerpt(match: string): string {
  return match.length <= MAX_EXCERPT_LENGTH ? match : `${match.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

/**
 * Screen a piece of text. Total: any string yields a report, and an empty or whitespace-only
 * string is clean.
 *
 * Every rule runs — the first violation does not short-circuit the rest — because an operator
 * fixing generated text needs the whole list, not a drip-feed of one violation per attempt.
 */
export function screenContent(text: string): ComplianceReport {
  const violations: ComplianceViolation[] = [];

  for (const { category, rule, pattern } of RULES) {
    for (const match of text.matchAll(pattern)) {
      violations.push({ category, rule, excerpt: boundExcerpt(match[0]), index: match.index });
    }
  }

  violations.sort((a, b) => a.index - b.index);
  return { ok: violations.length === 0, violations };
}

/**
 * A one-line, EXCERPT-FREE description of a report, for a field that travels further than the
 * report itself — a transport-level `reason`, a log line, a metric label.
 *
 * The omission is the point. An excerpt is by definition the content the guard just objected to,
 * so copying it into a delivery result would carry the suspected protected information into
 * exactly the outbound path the guard exists to close. The full report stays with the caller, who
 * records it inside the tenant's own store.
 */
export function describeViolations(report: ComplianceReport): string {
  if (report.violations.length === 0) return "no violations";
  return COMPLIANCE_CATEGORIES.map((category) => {
    const rules = [
      ...new Set(report.violations.filter((v) => v.category === category).map((v) => v.rule)),
    ];
    return rules.length === 0 ? null : `${category} (${rules.join(", ")})`;
  })
    .filter((part): part is string => part !== null)
    .join("; ");
}
