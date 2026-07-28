import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
} from "react";

/**
 * The console's shared presentational primitives (ticket 02).
 *
 * They hold NO state, do NO data access and make NO decisions — every one is a thin, typed wrapper
 * over the `.ds-*` classes in `globals.css`, which in turn read the component-token layer. That is
 * the entire point: a dashboard built from these gets the console's existing look for free, and a
 * change to the look is a change to a token rather than a sweep through four pages of markup.
 *
 * They are additive. Every page written before this ticket still renders against the original
 * classes, unchanged, and both ends resolve to the same tokens — so a critical case looks the same
 * whether it came through `.pill.sev-critical` or through `<Badge severity="critical">`.
 */

/** The severity ramp, as the console has always spelled it. */
export type Severity = "critical" | "high" | "moderate" | "low" | "none";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Colours the badge from the severity tokens. Omit for a neutral outline. */
  severity?: Severity;
  /** The accent-coloured variant the case and protocol tables use for a lifecycle state. */
  tone?: "status";
  children: ReactNode;
}

export function Badge({ severity, tone, className, children, ...rest }: BadgeProps) {
  const classes = ["ds-badge"];
  if (severity) classes.push(`ds-badge--${severity}`);
  if (tone) classes.push(`ds-badge--${tone}`);
  if (className) classes.push(className);
  return (
    <span className={classes.join(" ")} {...rest}>
      {children}
    </span>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "danger" | "quiet";
  /**
   * The three states a boolean `disabled` cannot express. `loading` also disables the button —
   * a button that looks busy but still fires is how a double-submit happens.
   */
  state?: "loading" | "error" | "success";
  children: ReactNode;
}

export function Button({
  variant = "primary",
  state,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = ["ds-button"];
  if (variant !== "primary") classes.push(`ds-button--${variant}`);
  if (className) classes.push(className);
  return (
    <button
      className={classes.join(" ")}
      data-state={state}
      disabled={disabled || state === "loading"}
      aria-busy={state === "loading" || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

// `title` on an HTML element is the tooltip attribute — a string. A card's title is a heading and
// may be any node, so the DOM attribute is dropped rather than widened; a caller that genuinely
// wants a tooltip can still pass `aria-label`.
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** Secondary line under the title — the console's established `.sub` voice. */
  sub?: ReactNode;
  children: ReactNode;
}

export function Card({ title, sub, className, children, ...rest }: CardProps) {
  return (
    <section className={className ? `ds-card ${className}` : "ds-card"} {...rest}>
      {title ? <h2 className="ds-card__title">{title}</h2> : null}
      {sub ? <p className="ds-card__sub">{sub}</p> : null}
      {children}
    </section>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Renders the invalid outline AND sets `aria-invalid`, so the two cannot disagree. */
  invalid?: boolean;
  /** Sizes the field to its container rather than to the full row. */
  inline?: boolean;
}

export function Input({ invalid, inline, className, ...rest }: InputProps) {
  const classes = ["ds-input"];
  if (inline) classes.push("ds-input--inline");
  if (className) classes.push(className);
  return <input className={classes.join(" ")} aria-invalid={invalid || undefined} {...rest} />;
}

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Column headings, in order. */
  head: ReactNode[];
  children: ReactNode;
}

export function Table({ head, className, children, ...rest }: TableProps) {
  return (
    // The scroll container is part of the primitive, not the caller's job to remember: a wide
    // table that pushes the page sideways on a phone is the single most common console defect,
    // and it is invisible until somebody opens it on a phone.
    <div className="ds-table-scroll">
      <table className={className ? `ds-table ${className}` : "ds-table"} {...rest}>
        <thead>
          <tr>
            {head.map((cell, i) => (
              // Headings are static per call site and carry no identity of their own; the index
              // IS the column, which is the one case where it is the honest key.
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
