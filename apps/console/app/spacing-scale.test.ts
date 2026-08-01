import { describe, expect, it } from "vitest";
import { readGlobalsCss } from "./design-test-helpers";

const css = readGlobalsCss();

function px(token: string): number {
  const m = new RegExp(`${token}:\\s*(\\d+)px;`).exec(css);
  if (!m?.[1]) throw new Error(`${token} is not declared as a px literal`);
  return Number(m[1]);
}

describe("the spacing scale", () => {
  it("starts at zero", () => {
    expect(css).toMatch(/--space-0:\s*0;/);
  });

  it("is contiguous through the fine end, with no step missing", () => {
    const steps = Array.from(css.matchAll(/--space-(\d+):/g), (m) => Number(m[1]))
      .filter((n) => n > 0 && n <= 9)
      .sort((a, b) => a - b);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it.each([1, 2, 3, 4, 5, 6])("step %i is that many times the 4px base", (n) => {
    expect(px(`--space-${n}`)).toBe(n * 4);
  });

  it("keeps the coarse end on the base too", () => {
    for (const [n, value] of [
      [7, 32],
      [8, 40],
      [9, 48],
      [10, 64],
      [12, 96],
    ] as const) {
      expect(px(`--space-${n}`)).toBe(value);
      expect(value % 4).toBe(0);
    }
  });

  // The two values that were deliberately left off the old scale. A component token holding a
  // raw `9px` is a value nothing else in the system can line up with, and it is invisible at the
  // call site because the call site reads a name.
  it.each(["--badge-pad-x", "--button-pad-y", "--card-pad-y", "--card-pad-x", "--button-pad-x"])(
    "%s reads the scale rather than a literal",
    (token) => {
      expect(new RegExp(`${token}:\\s*var\\(--space-\\d+\\);`).test(css)).toBe(true);
    },
  );

  it("has no off-base px literal left in the component token layer", () => {
    // Not "no literal at all": `--control-height: 44px` is a real component dimension with no
    // spacing step to name it (44 = 11 x 4, and there is no `--space-11`). What the old `9px` and
    // `18px` were is OFF the base — values nothing else in the system can line up with.
    const componentBlock = /---- Component:([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const offBase = Array.from(componentBlock.matchAll(/:\s*(\d+)px;/g), (m) =>
      Number(m[1]),
    ).filter((n) => n % 4 !== 0);
    expect(offBase).toEqual([]);
  });
});

describe("the radius scale", () => {
  it.each([
    ["--radius-sm", 6],
    ["--radius-md", 10],
    ["--radius-lg", 14],
  ])("defines %s as %ipx", (token, value) => {
    expect(px(token)).toBe(value);
  });

  it("keeps a pill radius that cannot be reached by rounding up a box", () => {
    expect(px("--radius-pill")).toBeGreaterThan(100);
  });
});
