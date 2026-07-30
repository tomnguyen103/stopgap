import { describe, expect, it } from "vitest";
import { CsvShapeError, parseCsv, toRecord } from "./csv.js";
import { coerceRow, itemIdentifiers } from "./rows.js";
import { planImport } from "./import.js";

const ITEMS_CSV = [
  "sku,name,generic_name,unit,ndc,rxcui,gtin,hibc,notes",
  'HEP-5K,"Heparin Sodium, 5000 units/mL",heparin sodium,vial,63323-540-01,1361574,,,"ward stock"',
  "SAL-09,Sodium Chloride 0.9%,sodium chloride,bag,,,00312345678906,,",
].join("\n");

describe("reading a delimited file", () => {
  it("keeps commas, escaped quotes and newlines inside quoted cells", () => {
    const doc = parseCsv('a,b\n"one, two","he said ""hi""\nagain"\n');
    expect(doc.header).toEqual(["a", "b"]);
    expect(doc.rows[0]?.cells).toEqual(["one, two", 'he said "hi"\nagain']);
  });

  it("normalises header case and strips the BOM Excel writes", () => {
    expect(parseCsv("\u{FEFF}SKU,Name\nA,B\n").header).toEqual(["sku", "name"]);
  });

  it("reads CRLF files, and ignores the empty row a trailing newline leaves", () => {
    const doc = parseCsv("a,b\r\n1,2\r\n");
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]?.cells).toEqual(["1", "2"]);
  });

  it("refuses a ragged row rather than padding it into a plausible wrong value", () => {
    expect(() => parseCsv("a,b,c\n1,2\n")).toThrow(CsvShapeError);
  });

  it("reports the line number a spreadsheet would show", () => {
    try {
      parseCsv("a,b\n1,2\n1,2,3\n");
      expect.unreachable("expected a shape error");
    } catch (error) {
      expect((error as CsvShapeError).line).toBe(3);
    }
  });

  it("counts the lines a multi-line quoted cell spans, and reports where its row STARTED", () => {
    const doc = parseCsv(['a,b', 'one,"line one', 'line two"', "three,four"].join("\n"));
    expect(doc.rows.map((r) => r.line)).toEqual([2, 4]);
  });

  it("addresses cells by header name", () => {
    const doc = parseCsv(ITEMS_CSV);
    const record = toRecord(doc.header, doc.rows[0]!);
    expect(record.sku).toBe("HEP-5K");
    expect(record.name).toBe("Heparin Sodium, 5000 units/mL");
  });
});

describe("coercion", () => {
  it("carries several identifier types for one item at once", () => {
    const plan = planImport("items", ITEMS_CSV);
    expect(plan.ok).toBe(true);
    expect(itemIdentifiers(plan.rows[0]!.row)).toEqual([
      { type: "sku", value: "HEP-5K" },
      { type: "ndc", value: "63323-540-01" },
      { type: "rxcui", value: "1361574" },
    ]);
    // A facility recording only a GTIN still gets its own sku as an identifier.
    expect(itemIdentifiers(plan.rows[1]!.row).map((i) => i.type)).toEqual(["sku", "gtin"]);
  });

  it("carries every identifier system the catalog story names", () => {
    const result = coerceRow("items", {
      sku: "A",
      name: "B",
      ndc: "1",
      rxcui: "2",
      gtin: "3",
      upc: "4",
      hibc: "5",
      mpn: "6",
      fda_app_no: "7",
    });
    expect(result.ok && itemIdentifiers(result.row).map((i) => i.type)).toEqual([
      "sku",
      "ndc",
      "rxcui",
      "gtin",
      "upc",
      "hibc",
      "mpn",
      "fda_app_no",
    ]);
  });

  it("defaults a missing purchase-order reference to the empty string, not to undefined", () => {
    const result = coerceRow("procurement", {
      facility_code: "F1",
      sku: "A",
      ordered_at: "2026-07-01",
      quantity: "2",
    });
    expect(result.ok && result.row.order_ref).toBe("");
  });

  it("treats a blank optional cell as absent, never as an empty value", () => {
    const result = coerceRow("items", { sku: "A", name: "B", generic_name: "  " });
    expect(result.ok && result.row.generic_name).toBeUndefined();
  });

  it("rejects a non-numeric quantity instead of coercing it to zero", () => {
    const result = coerceRow("inventory", {
      facility_code: "F1",
      sku: "A",
      on_hand: "n/a",
      captured_at: "2026-07-01",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.column).toBe("on_hand");
    expect(result.ok === false && result.reason).toMatch(/must be a number/);
  });

  it("rejects a negative on-hand count", () => {
    const result = coerceRow("inventory", {
      facility_code: "F1",
      sku: "A",
      on_hand: "-3",
      captured_at: "2026-07-01",
    });
    expect(result.ok === false && result.reason).toMatch(/cannot be negative/);
  });

  it("accepts thousands separators, because spreadsheets emit them", () => {
    const result = coerceRow("inventory", {
      facility_code: "F1",
      sku: "A",
      on_hand: "1,250",
      captured_at: "2026-07-01T00:00:00Z",
    });
    expect(result.ok && result.row.on_hand).toBe(1250);
  });

  it("normalises dates to ISO and rejects what is not one", () => {
    const good = coerceRow("procurement", {
      facility_code: "F1",
      sku: "A",
      ordered_at: "2026-07-01",
      quantity: "2",
    });
    expect(good.ok && good.row.ordered_at).toBe("2026-07-01T00:00:00.000Z");
    const bad = coerceRow("procurement", {
      facility_code: "F1",
      sku: "A",
      ordered_at: "last tuesday",
      quantity: "2",
    });
    expect(bad.ok === false && bad.column).toBe("ordered_at");
  });

  it("reads the several ways a spreadsheet writes a boolean", () => {
    for (const [cell, expected] of [
      ["yes", true],
      ["TRUE", true],
      ["1", true],
      ["no", false],
      ["", false],
    ] as const) {
      const result = coerceRow("item_suppliers", {
        sku: "A",
        supplier_code: "S",
        preferred: cell,
      });
      expect(result.ok && result.row.preferred, cell).toBe(expected);
    }
  });
});

describe("planning an import", () => {
  it("reports every invalid row individually, with line, column and reason", () => {
    const plan = planImport(
      "inventory",
      [
        "facility_code,sku,on_hand,captured_at",
        "F1,HEP-5K,10,2026-07-01",
        "F1,,4,2026-07-01",
        "F1,SAL-09,many,2026-07-01",
        "F1,SAL-09,4,whenever",
      ].join("\n"),
    );
    expect(plan.ok).toBe(false);
    expect(plan.rows).toHaveLength(1);
    expect(plan.errors).toEqual([
      { line: 3, column: "sku", reason: "sku is required" },
      { line: 4, column: "on_hand", reason: "on_hand must be a number" },
      {
        line: 5,
        column: "captured_at",
        reason: "captured_at must be an ISO date (YYYY-MM-DD) or a datetime carrying a timezone",
      },
    ]);
  });

  it("reports a missing column once against the header, not once per row", () => {
    const plan = planImport("items", ["sku,generic_name", "A,heparin", "B,saline"].join("\n"));
    expect(plan.errors).toEqual([{ line: 1, reason: "missing required column(s): name" }]);
    expect(plan.rows).toHaveLength(0);
  });

  it("turns a ragged file into one reported error rather than a thrown import", () => {
    const plan = planImport("items", ["sku,name", "A,B", "C"].join("\n"));
    expect(plan.ok).toBe(false);
    expect(plan.errors[0]?.line).toBe(3);
    expect(plan.errors[0]?.reason).toMatch(/expected 2 cells/);
  });

  it("plans nothing to write when the file is empty", () => {
    expect(planImport("items", "")).toMatchObject({ rows: [], ok: false });
  });

  it("refuses a header that names the same column twice, once against the header", () => {
    // `toRecord` keys by name, so a second `sku` column overwrites the first and the file imports
    // as a plausible wrong value rather than as a reported defect.
    const plan = planImport("items", ["sku,name,sku", "A-1,Widget,A-2"].join("\n") + "\n");
    expect(plan.ok).toBe(false);
    expect(plan.rows).toHaveLength(0);
    expect(plan.errors).toEqual([
      { line: 1, reason: "header names the same column more than once: sku" },
    ]);
  });

  it("requires a datetime to carry a timezone, and accepts a date-only value", () => {
    const inventory = (capturedAt: string) =>
      planImport(
        "inventory",
        ["facility_code,sku,on_hand,captured_at", `F1,A-1,4,${capturedAt}`].join("\n") + "\n",
      );
    // A date-only value is unambiguous by convention; a bare datetime means a different instant on
    // every deployment, because `Date.parse` resolves it in the SERVER's zone.
    expect(inventory("2026-07-01").ok).toBe(true);
    expect(inventory("2026-07-01T08:00:00Z").ok).toBe(true);
    expect(inventory("2026-07-01T08:00:00+02:00").ok).toBe(true);
    expect(inventory("2026-07-01T08:00:00").ok).toBe(false);
    // Shape is checked BEFORE `Date.parse`, so a US-style date is refused rather than silently
    // resolved month-first — the failure mode a European procurement export would hit.
    expect(inventory("07/01/2026").ok).toBe(false);
    // And a value that matches the shape but is not a real day is still refused — JS rolls
    // `2026-02-30` forward to March 2 rather than rejecting it.
    expect(inventory("2026-02-30").ok).toBe(false);
    // A qualified datetime whose UTC instant falls on the PREVIOUS day is still valid: the
    // calendar day is checked on its own, not against the parsed instant.
    expect(inventory("2026-07-01T01:00:00+02:00").ok).toBe(true);
  });

  it("keeps a multi-line quoted cell free of carriage returns", () => {
    // Excel writes an embedded newline as CRLF; appending the `\r` verbatim leaves a control
    // character inside the note, invisible on screen and unequal to the same text typed by hand.
    const text = 'sku,name,notes\r\nA-1,Widget,"line one\r\nline two"\r\n';
    const plan = planImport("items", text);
    expect(plan.ok).toBe(true);
    expect(plan.rows[0]?.row.notes).toBe("line one\nline two");
  });

  it("is pure — planning the same text twice yields the same plan", () => {
    expect(planImport("items", ITEMS_CSV)).toEqual(planImport("items", ITEMS_CSV));
  });
});
