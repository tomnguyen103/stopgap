import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "type" | "aria-pressed"
> {
  /** Whether the thing this toggle names is currently granted. */
  pressed: boolean;
  children: ReactNode;
}

/**
 * A two-state selector whose two states look different.
 *
 * Both call sites — API-key scopes and user roles — were
 * `className={on ? "pill" : "pill muted"}`, and `.muted` is defined nowhere in the stylesheet.
 * Both states therefore rendered as the same outlined pill and the entire difference between
 * "this key may write protocols" and "it may not" was a `✓` glyph in front of the label. On a
 * credential surface that is not a styling nit: it is the operator reading a grant they did not
 * make.
 *
 * `aria-pressed` is the component's, not the caller's — a toggle whose visual state and announced
 * state can disagree is worse than one with no announced state at all. The glyph is `aria-hidden`
 * for the same reason: `aria-pressed` already says it, and saying it twice is noise.
 */
export function Toggle({ pressed, className, children, ...rest }: ToggleProps) {
  const classes = ["ds-toggle", pressed ? "ds-toggle--on" : "ds-toggle--off"];
  if (className) classes.push(className);
  return (
    <button {...rest} type="button" className={classes.join(" ")} aria-pressed={pressed}>
      {pressed ? (
        <span aria-hidden="true" className="ds-toggle__mark">
          ✓
        </span>
      ) : null}
      {children}
    </button>
  );
}
