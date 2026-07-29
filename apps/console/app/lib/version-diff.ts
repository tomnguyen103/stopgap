/**
 * What changed between two protocol versions (ticket 14).
 *
 * A LINE diff, not a word one: a protocol is read as instructions, and the unit a director approves
 * or rejects is a line of guidance. Pure and framework-free, so "the history says what changed" is
 * asserted in the offline gate rather than by looking at a page.
 *
 * The algorithm is a longest-common-subsequence walk. Quadratic in the number of lines, which is
 * the honest trade here: a protocol is tens of lines, and an O(n log n) heuristic would sometimes
 * pair unrelated lines and report a rewrite where a word moved.
 */

export type DiffKind = "added" | "removed" | "unchanged";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

function splitLines(text: string): string[] {
  // A trailing newline is not a line. Without this, appending one to an unchanged body reports a
  // removed-and-added empty line and a director reads "changed" where nothing did.
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Exactly ONE, which is the split artifact of a trailing newline. Popping every trailing blank
  // would report "no textual change" when an author deliberately removed the blank lines under a
  // protocol — a real edit, silently swallowed.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The diff from `before` to `after`, in reading order. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const width = b.length + 1;
  // One flat array rather than an array of arrays: the row-and-column read is the hot path, and a
  // flat index also sidesteps the "possibly undefined" of a nested lookup without an assertion.
  const lcs = new Int32Array((a.length + 1) * width);
  // `noUncheckedIndexedAccess` types every element read as possibly undefined, including a typed
  // array's. Reading through one accessor keeps the arithmetic below readable and assertion-free.
  const at = (index: number): number => lcs[index] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? at((i + 1) * width + (j + 1)) + 1
          : Math.max(at((i + 1) * width + j), at(i * width + (j + 1)));
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] ?? "";
    const right = b[j] ?? "";
    if (left === right) {
      out.push({ kind: "unchanged", text: left });
      i++;
      j++;
    } else if (at((i + 1) * width + j) >= at(i * width + (j + 1))) {
      out.push({ kind: "removed", text: left });
      i++;
    } else {
      out.push({ kind: "added", text: right });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] ?? "" });
  while (j < b.length) out.push({ kind: "added", text: b[j++] ?? "" });
  return out;
}

/** A one-line summary — what a version row says before anyone opens the diff. */
export function summarizeDiff(diff: DiffLine[]): string {
  const added = diff.filter((line) => line.kind === "added").length;
  const removed = diff.filter((line) => line.kind === "removed").length;
  if (added === 0 && removed === 0) return "no textual change";
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} line${added === 1 ? "" : "s"} added`);
  if (removed > 0) parts.push(`${removed} line${removed === 1 ? "" : "s"} removed`);
  return parts.join(", ");
}
