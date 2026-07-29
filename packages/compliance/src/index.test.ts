import { describe, expect, it } from "vitest";
import { COMPLIANCE_CATEGORIES, describeViolations, screenContent } from "./index";

/** Every assertion here is a pattern the guard must catch, phrased as text a model plausibly emits. */
function categoriesOf(text: string): string[] {
  return [...new Set(screenContent(text).violations.map((v) => v.category))];
}

describe("screenContent — protected information", () => {
  it.each([
    ["a medical record number", "See MRN 4471902 for the prior order."],
    ["a spelled-out record number", "Medical Record Number: A-99213"],
    ["a date of birth", "DOB 1972-04-11, admitted Tuesday."],
    ["a national identifier", "SSN 123-45-6789 on file."],
    ["an unpunctuated labelled national identifier", "SSN 123456789 on file."],
    ["a space-separated labelled national identifier", "SSN 123 45 6789 on file."],
    // Spelled out AND unpunctuated, so the label branch is what carries the match — the
    // hyphenated core would be caught with no label at all.
    ["a spelled-out national identifier", "Social Security Number: 123456789 on file."],
    ["an abbreviated spelled-out national identifier", "Social Security No. 123456789 on file."],
    ["a phone number", "Call the family at 415-555-0134."],
    ["an email address", "Forward to j.doe@example-hospital.org."],
  ])("detects %s", (_label, text) => {
    expect(categoriesOf(text)).toContain("phi_identifier");
  });

  it("does not fire on a drug strength that merely looks numeric", () => {
    // The guard sits in front of ordinary product prose. Flagging "0.9% sodium chloride 500 mL"
    // would make every legitimate protocol a violation, and a guard that always fires is one
    // somebody switches off.
    expect(screenContent("Sodium chloride 0.9% 500 mL, NDC 0338-0049-04.").ok).toBe(true);
  });
});

describe("screenContent — clinical boundary", () => {
  it.each([
    [
      "a records-system reference",
      "Documented in Epic under the encounter.",
      "records_system_reference",
    ],
    ["an EHR mention", "Pull the EMR entry before substituting.", "records_system_reference"],
    [
      "diagnosis language",
      "Patients diagnosed with sepsis should receive it.",
      "diagnosis_or_treatment",
    ],
    [
      "a possessive prognosis",
      "The patient's prognosis improved once the alternative arrived.",
      "diagnosis_or_treatment",
    ],
    // The person and the clinical term are one statement about one person however they are
    // ordered, so each direction is pinned: an anchor that only reads left-to-right lets the
    // commonest clinical phrasing of all — the passive — straight through.
    [
      "a passive diagnosis",
      "The patient was diagnosed with sepsis before the substitution.",
      "diagnosis_or_treatment",
    ],
    [
      "a clinician-subject diagnosis",
      "The clinician diagnosed the patient with sepsis.",
      "diagnosis_or_treatment",
    ],
    ["a prognosis about a person", "Prognosis is poor for the patient.", "diagnosis_or_treatment"],
    [
      "treatment language",
      "Prescribed for the patient at 2 g every eight hours.",
      "diagnosis_or_treatment",
    ],
    [
      "patient-specific phrasing",
      "This patient tolerated the alternative well.",
      "patient_specific",
    ],
    ["a bedside reference", "Check the patient in room 412 before switching.", "patient_specific"],
    [
      "a substitution directive",
      "Switch the patient to cefazolin today.",
      "substitution_directive",
    ],
  ])("detects %s", (_label, text, category) => {
    expect(categoriesOf(text)).toContain(category);
  });

  it.each([
    ["prescribing information", "See the prescribing information for storage conditions."],
    ["dispensing instructions", "Dispense as prescribed by the ordering service."],
    ["an indication class", "Ceftriaxone is indicated for treatment of the same infections."],
    ["a labelled regimen", "The equivalent dosing regimen is 2 g q24h."],
    ["a labelled dosage", "Recommended dosage for adults is on the label."],
    ["assay titration", "Assay by titration per USP monograph."],
    ["an alternative therapy class", "Alternative therapy for the same indication class."],
    ["an expiry warning", "Do not administer past the expiry date."],
    ["a cleanroom", "Stored in the clean room 3 cage."],
    ["a stock cart", "Ward bed 12 stock cart was not restocked."],
    ["an ordinary adjective", "An epic backlog of back-ordered vials cleared this week."],
    ["a lot number", "Lot 415 555 0134 shipped on Tuesday."],
    ["an unlabelled nine-digit run", "Batch 123456789 cleared quality release."],
    ["monograph comorbidity prose", "Comorbidities associated with reduced renal function."],
    ["a coding reference", "Differential diagnosis codes are out of scope for this note."],
  ])("does not fire on label and supply vocabulary: %s", (_label, text) => {
    // Every line here is text a legitimate substitution protocol or supply note plausibly
    // contains. The rules are anchored on language pointing at a PERSON precisely so that these
    // pass: a guard that blocks the permitted surface is one an operator switches off, and a
    // switched-off guard enforces nothing at all.
    expect(screenContent(text).violations).toEqual([]);
  });

  it("passes product-level administrative prose, which is the whole product", () => {
    // The non-clinical boundary is the claim; the guard exists to enforce it, not to make the
    // permitted surface unusable.
    const report = screenContent(
      "Cefazolin 1 g vials are on shortage from two of three suppliers; 14 days on hand remain. " +
        "Ceftriaxone 1 g is an equivalent-class product with no active recall.",
    );
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });
});

describe("screenContent — report shape", () => {
  it("names the category and quotes the offending excerpt, rather than returning a bare boolean", () => {
    // A boolean tells an operator nothing about which line to fix, so a false positive would be
    // indistinguishable from a real violation and the guard would be turned off rather than tuned.
    const report = screenContent("Contact the caregiver on 415-555-0134 about the swap.");
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      category: "phi_identifier",
      rule: "phone_number",
      excerpt: "415-555-0134",
    });
    // The offset must point AT the match in the screened string — an operator quoting the report
    // back against the text is the whole reason the field exists.
    expect(report.violations[0]?.index).toBe(
      "Contact the caregiver on 415-555-0134 about the swap.".indexOf("415-555-0134"),
    );
  });

  it("reports every violation in one pass, not just the first", () => {
    const report = screenContent("DOB 1972-04-11. This patient is documented in Cerner.");
    expect(categoriesOf("DOB 1972-04-11. This patient is documented in Cerner.")).toEqual(
      expect.arrayContaining(["phi_identifier", "patient_specific", "records_system_reference"]),
    );
    expect(report.violations.length).toBeGreaterThanOrEqual(3);
  });

  it("orders violations by where they appear, so the report reads with the text", () => {
    const report = screenContent("This patient has MRN 4471902.");
    const indices = report.violations.map((v) => v.index);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("bounds an excerpt, so a pathological match cannot inflate what gets stored", () => {
    const report = screenContent(`Medical Record Number: ${"A".repeat(5_000)}`);
    expect(report.ok).toBe(false);
    for (const violation of report.violations)
      expect(violation.excerpt.length).toBeLessThanOrEqual(120);
  });

  it.each([
    ["empty text", ""],
    ["whitespace", "   \n\t "],
  ])("passes %s without throwing", (_label, text) => {
    expect(screenContent(text).ok).toBe(true);
  });

  it("is deterministic — the same text screens identically twice", () => {
    // Regex `lastIndex` on a global pattern is the classic way this silently stops being true.
    const text = "DOB 1972-04-11 and MRN 4471902.";
    expect(screenContent(text)).toEqual(screenContent(text));
  });
});

describe("describeViolations", () => {
  it("names categories and rules only, never the excerpt", () => {
    // This string is what a transport-level `reason` carries. Putting the excerpt in it would
    // move the very content the guard blocked into a field that travels further than the report.
    const report = screenContent("SSN 123-45-6789 on file.");
    const description = describeViolations(report);
    expect(description).toContain("phi_identifier");
    expect(description).not.toContain("123-45-6789");
  });

  it("says so plainly when there is nothing to describe", () => {
    expect(describeViolations(screenContent("Cefazolin 1 g is on shortage."))).toBe(
      "no violations",
    );
  });
});

describe("COMPLIANCE_CATEGORIES", () => {
  it("lists exactly the categories the spec names", () => {
    expect([...COMPLIANCE_CATEGORIES]).toEqual([
      "phi_identifier",
      "records_system_reference",
      "diagnosis_or_treatment",
      "patient_specific",
      "substitution_directive",
    ]);
  });
});
