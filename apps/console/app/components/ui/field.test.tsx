import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";

/**
 * The controls this exists for are the review textarea — the most consequential control in the
 * product, and previously with no accessible name at all — and the four fields around it that used
 * their placeholder as their label. A placeholder disappears the moment a character is typed, so a
 * pharmacist mid-sentence has nothing on screen saying which box they are in, and a screen reader
 * reading a re-visited field announces an empty textbox.
 */
const CALL_SITES = [
  "../../(pharmacist)/cases/[id]/review-panel.tsx",
  "../../(admin)/admin/api-keys/api-keys-admin.tsx",
] as const;

function read(site: string): string {
  return readFileSync(fileURLToPath(new URL(site, import.meta.url)), "utf8");
}

function count(source: string, needle: RegExp): number {
  return source.match(needle)?.length ?? 0;
}

describe("Field", () => {
  it("binds its label to the control it wraps", () => {
    const html = renderToStaticMarkup(
      <Field label="Draft protocol">{(id) => <textarea id={id} />}</Field>,
    );
    const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    const controlId = /<textarea[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(labelFor).toBeTruthy();
    expect(controlId).toBe(labelFor);
  });

  it("renders the label as visible text, not as an sr-only afterthought", () => {
    const html = renderToStaticMarkup(<Field label="Draft protocol">{(id) => <input id={id} />}</Field>);
    expect(html).toContain("Draft protocol");
    expect(html).not.toContain("ds-sr-only");
  });

  it("associates an optional hint with the control via aria-describedby", () => {
    const html = renderToStaticMarkup(
      <Field label="Reason" hint="Recorded on the case">
        {(id, describedBy) => <input id={id} aria-describedby={describedBy} />}
      </Field>,
    );
    const hintTag = /<p[^>]*class="ds-field__hint"[^>]*>/.exec(html)?.[0];
    const hintId = hintTag ? /id="([^"]+)"/.exec(hintTag)?.[1] : undefined;
    expect(hintId).toBeTruthy();
    expect(html).toContain(`aria-describedby="${hintId}"`);
  });

  it("gives every control a distinct id when several fields render together", () => {
    const html = renderToStaticMarkup(
      <>
        <Field label="A">{(id) => <input id={id} />}</Field>
        <Field label="B">{(id) => <input id={id} />}</Field>
      </>,
    );
    const ids = Array.from(html.matchAll(/<input[^>]*id="([^"]+)"/g), (m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it.each(CALL_SITES)("%s labels every control it renders", (site) => {
    const source = read(site);
    const controls = count(source, /<(?:input|textarea)\b/g);
    expect(controls).toBeGreaterThan(0);
    expect(count(source, /<Field\b/g)).toBe(controls);
  });

  it.each(CALL_SITES)("%s no longer uses a placeholder as a label", (site) => {
    expect(read(site)).not.toContain("placeholder=");
  });
});
