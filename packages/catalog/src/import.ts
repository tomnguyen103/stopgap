import { CsvDuplicateHeaderError, CsvShapeError, parseCsv, toRecord } from "./csv.js";
import { REQUIRED_COLUMNS, coerceRow, type CatalogKind, type CatalogRow } from "./rows.js";

/**
 * Turning an uploaded file into "what would be written, and what is wrong with it" — with nothing
 * written.
 *
 * The plan is the whole decision. The write layer's job is then narrow enough to be one
 * transaction: apply this, or apply none of it. Splitting them this way is what makes
 * "a failed import leaves no partial data" a property of the code rather than a hope — a caller
 * that refuses to write a plan carrying errors cannot half-import a bad file (ticket 15).
 */

export interface RowError {
  /** 1-based line number in the uploaded file, as a spreadsheet would show it. */
  line: number;
  column?: string;
  reason: string;
}

export interface ImportPlan<K extends CatalogKind> {
  kind: K;
  rows: { line: number; row: CatalogRow[K] }[];
  errors: RowError[];
  /** True when every row coerced. The write layer refuses anything else. */
  ok: boolean;
}

/**
 * Read a file into a plan.
 *
 * Every invalid row is reported INDIVIDUALLY with its line, its column where one is identifiable,
 * and the reason — rather than stopping at the first. An administrator fixing a 4,000-line export
 * needs the whole list; one error per upload round-trip makes a bad file take as many uploads as
 * it has mistakes.
 */
export function planImport<K extends CatalogKind>(kind: K, text: string): ImportPlan<K> {
  const errors: RowError[] = [];
  const rows: { line: number; row: CatalogRow[K] }[] = [];

  let document;
  try {
    document = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvDuplicateHeaderError) {
      // A FILE defect, reported once against line 1 — the same rule the missing-column check
      // below follows. There is no row to blame: the header is wrong before any row is read.
      return { kind, rows: [], errors: [{ line: 1, reason: error.message }], ok: false };
    }
    if (error instanceof CsvShapeError) {
      return {
        kind,
        rows: [],
        errors: [{ line: error.line, reason: error.message.replace(/^line \d+: /, "") }],
        ok: false,
      };
    }
    throw error;
  }

  const missing = REQUIRED_COLUMNS[kind].filter((c) => !document.header.includes(c));
  if (missing.length > 0) {
    // A header defect is a FILE defect, reported once against line 1 rather than repeated against
    // every row — the same mistake restated 4,000 times is not 4,000 pieces of information.
    return {
      kind,
      rows: [],
      errors: [{ line: 1, reason: `missing required column(s): ${missing.join(", ")}` }],
      ok: false,
    };
  }

  for (const csvRow of document.rows) {
    const result = coerceRow(kind, toRecord(document.header, csvRow));
    if (result.ok) rows.push({ line: csvRow.line, row: result.row });
    else errors.push({ line: csvRow.line, column: result.column, reason: result.reason });
  }

  return { kind, rows, errors, ok: errors.length === 0 };
}
