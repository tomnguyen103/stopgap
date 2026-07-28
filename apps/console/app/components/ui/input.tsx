import type { InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * The field's validation outcome.
   *
   * `error` also sets `aria-invalid`, so the outline and the accessibility tree cannot disagree —
   * a field that looks wrong to a sighted user and reads fine to a screen reader is worse than one
   * that looks fine to both.
   */
  state?: "error" | "success";
  /** Sizes the field to its container rather than to the full row. */
  inline?: boolean;
}

export function Input({ state, inline, className, ...rest }: InputProps) {
  const classes = ["ds-input"];
  if (inline) classes.push("ds-input--inline");
  if (className) classes.push(className);
  return (
    <input
      {...rest}
      className={classes.join(" ")}
      data-state={state}
      aria-invalid={state === "error" || undefined}
    />
  );
}
