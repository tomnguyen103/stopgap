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
      { line: 5, column: "captured_at", reason: "captured_at must be an ISO date" },
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

  it("is pure — planning the same text twice yields the same plan", () => {
    expect(planImport("items", ITEMS_CSV)).toEqual(planImport("items", ITEMS_CSV));
  });
});
