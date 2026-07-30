/**
 * CSV reading, one delimited document to a header and rows of cells.
 *
 * Hand-rolled rather than taken from a dependency because the surface actually needed is small
 * (quotes, escaped quotes, embedded newlines, CRLF, a BOM) and every one of those cases is
 * asserted below in `catalog.test.ts`. A parser is also the one place an import can silently go wrong
 * without erroring — a mis-split row lands as data, not as a failure — so it is worth owning.
 *
 * NOTHING here validates meaning. This layer answers "what cells did the file contain"; the
 * schemas in `rows.ts` answer "is that a catalog row", and the write layer in `@stopgap/db`
 * answers "does it belong to this tenant". Keeping the three apart is what lets the first two be
 * tested with no database in front of them.
 */

export interface CsvDocument {
  /** Header cells, in file order, trimmed and lowercased so `SKU` and `sku` name one column. */
  header: string[];
  /** Data rows, each already aligned to the header's width. */
  rows: CsvRow[];
}

export interface CsvRow {
  /** 1-based line number as a human reading the file in a spreadsheet would count it. */
  line: number;
  cells: string[];
}

/** A cell count that does not match the header — the failure a naive `split(",")` hides. */
export class CsvShapeError extends Error {
  constructor(
    readonly line: number,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`line ${line}: expected ${expected} cells, found ${actual}`);
    this.name = "CsvShapeError";
  }
}

/**
 * A header naming the same column twice.
 *
 * Its own error rather than a shape error, because the file is the right WIDTH — the defect is
 * that two columns claim one name, and the message has to say which.
 */
export class CsvDuplicateHeaderError extends Error {
  constructor(readonly duplicates: string[]) {
    super(`header names the same column more than once: ${duplicates.join(", ")}`);
    this.name = "CsvDuplicateHeaderError";
  }
}

/**
 * Split a CSV document into cells.
 *
 * Ragged rows are NOT silently padded or truncated: a row whose width disagrees with the header
 * means the file's structure is not what the uploader thinks it is, and quietly filling the gap
 * with an empty string would turn a structural error into a plausible-looking wrong value. It
 * throws; the import layer catches it as a per-row error.
 */
export function parseCsv(text: string): CsvDocument {
  const rows = splitRows(text);
  const headerRow = rows[0];
  if (!headerRow) return { header: [], rows: [] };
  const header = headerRow.cells.map((c) => c.trim().toLowerCase());
  // A DUPLICATED HEADER NAME IS REFUSED, not resolved. `toRecord` keys by name, so `sku,name,sku`
  // maps both `sku` columns onto one key and the LAST cell silently wins — an administrator's
  // duplicated column becomes a plausible wrong value rather than a reported defect, which is the
  // failure this module refuses everywhere else (see the ragged-row rule above).
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size > 0) throw new CsvDuplicateHeaderError([...duplicates]);
  const body: CsvRow[] = [];
  for (const row of rows.slice(1)) {
    // A trailing newline yields one empty row; that is formatting, not a defect.
    if (row.cells.length === 1 && row.cells[0]?.trim() === "") continue;
    if (row.cells.length !== header.length) {
      throw new CsvShapeError(row.line, header.length, row.cells.length);
    }
    body.push(row);
  }
  return { header, rows: body };
}

/** Pair a row's cells with the header, so callers address columns by name rather than index. */
export function toRecord(header: string[], row: CsvRow): Record<string, string> {
  const record: Record<string, string> = {};
  header.forEach((name, i) => {
    record[name] = (row.cells[i] ?? "").trim();
  });
  return record;
}

/**
 * The byte-order mark Excel writes by default.
 *
 * Written as an escape rather than as the character itself: left literal it is an invisible glyph
 * in the source that a reviewer cannot see and a linter flags as irregular whitespace.
 */
const BOM = "\u{FEFF}";

function splitRows(text: string): CsvRow[] {
  // Left in place, the BOM becomes part of the FIRST header name — so every lookup of that column
  // misses, for a reason that is invisible on screen.
  const input = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  // The line the CURRENT row began on. A row with an embedded newline in a quoted cell spans
  // several lines, and the one worth reporting is where the administrator's row starts, not where
  // it happens to end.
  let rowStart = 1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"'; // an escaped quote inside a quoted cell
          i++;
        } else {
          quoted = false;
        }
      } else {
        // A newline INSIDE a quoted cell still advances the file's line count. Without this the
        // line number reported for every later row is short by however many embedded newlines
        // came before it — and a wrong line number in an error report is worse than none, because
        // the administrator edits the row it names.
        //
        // CRLF is normalized here exactly as it is for an unquoted row below. Excel writes a
        // multi-line quoted cell with `\r\n`, and appending the `\r` verbatim leaves a control
        // character inside an item name or note — invisible in the console, and unequal to the
        // same text typed by hand. A LONE `\r` is a line break too, and counting it is what stops
        // every later line number drifting.
        if (ch === "\r") {
          if (input[i + 1] === "\n") i++;
          line++;
          cell += "\n";
          continue;
        }
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ line: rowStart, cells });
      cells = [];
      cell = "";
      line++;
      rowStart = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowStart, cells });
  }
  return rows;
}
