import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every failure the console shows has to reach a screen reader.
 *
 * These messages are rendered by a state change, not by navigation — a role clicks Approve, the
 * server action throws, and a paragraph appears somewhere below the button. Nothing moves focus
 * and nothing announces it, so without a live region the only signal that the decision did NOT
 * land is a visual one. `ImportPanel` already got this right; eight other sites did not, and one
 * of them is the pharmacist review panel.
 *
 * `role="alert"` is an assertive live region and needs no JavaScript, which is why it is the fix
 * rather than a focus-management scheme.
 */
const APP = fileURLToPath(new URL(".", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsxFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

/** Opening tags carrying the error class. These are all simple one-line paragraphs. */
function errorTags(source: string): string[] {
  return Array.from(source.matchAll(/<[a-zA-Z]+[^>]*className="error"[^>]*>/g), (m) => m[0]);
}

describe("error messages", () => {
  const files = tsxFiles(APP);

  it("finds the console's error paragraphs at all", () => {
    expect(files.flatMap((f) => errorTags(readFileSync(f, "utf8"))).length).toBeGreaterThan(0);
  });

  it("announces every one of them with role=alert", () => {
    const silent = files.filter((file) =>
      errorTags(readFileSync(file, "utf8")).some((tag) => !tag.includes('role="alert"')),
    );
    expect(silent.map((f) => f.slice(APP.length).replaceAll("\\", "/"))).toEqual([]);
  });
});
