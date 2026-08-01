import { describe, expect, it } from "vitest";
import { componentSources, relativeToApp } from "./design-test-helpers";

/**
 * Every failure the console shows has to reach a screen reader.
 *
 * These messages are rendered by a state change, not by navigation — a role clicks Approve, the
 * server action throws, and a paragraph appears somewhere below the button. Nothing moves focus
 * and nothing announces it, so without a live region the only signal that the decision did NOT
 * land is a visual one. `ImportPanel` already got this right; seven other sites did not, and one
 * of them is the pharmacist review panel.
 *
 * `role="alert"` is an assertive live region and needs no JavaScript, which is why it is the fix
 * rather than a focus-management scheme.
 */

/** Opening tags carrying the error class. These are all simple one-line paragraphs. */
function errorTags(source: string): string[] {
  return Array.from(source.matchAll(/<[a-zA-Z]+[^>]*className="error"[^>]*>/g), (m) => m[0]);
}

describe("error messages", () => {
  const sources = componentSources();

  it("finds the console's error paragraphs at all", () => {
    expect(sources.flatMap(({ text }) => errorTags(text)).length).toBeGreaterThan(0);
  });

  it("announces every one of them with role=alert", () => {
    const silent = sources
      .filter(({ text }) => errorTags(text).some((tag) => !tag.includes('role="alert"')))
      .map(({ path }) => relativeToApp(path));
    expect(silent).toEqual([]);
  });
});
