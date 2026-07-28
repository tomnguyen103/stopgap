import type { HTMLAttributes, ReactNode } from "react";

/** The severity ramp, as the console has always spelled it. */
export type Severity = "critical" | "high" | "moderate" | "low" | "none";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Colours the badge from the severity tokens. Omit for a neutral outline.
   *
   * Resolves through `--severity-*` onto the very same `--crit`/`--high`/`--mod`/`--low` the
   * existing `.sev-*` classes read, so a critical case cannot look one way through the old class
   * and another through this component.
   */
  severity?: Severity;
  /** The accent-coloured variant a lifecycle state uses (`approved`, `monitoring`). */
  tone?: "status";
  children: ReactNode;
}

export function Badge({ severity, tone, className, children, ...rest }: BadgeProps) {
  const classes = ["ds-badge"];
  if (severity) classes.push(`ds-badge--${severity}`);
  if (tone) classes.push(`ds-badge--${tone}`);
  if (className) classes.push(className);
  return (
    <span {...rest} className={classes.join(" ")}>
      {children}
    </span>
  );
}
