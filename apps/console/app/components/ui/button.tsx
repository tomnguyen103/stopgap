import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "danger" | "quiet";
  /**
   * The three conditions a boolean `disabled` cannot express.
   *
   * `loading` also disables the button — one that looks busy but still fires is how a
   * double-submit happens.
   */
  state?: "loading" | "error" | "success";
  children: ReactNode;
}

/**
 * The console's button, with every state it can be in.
 *
 * A primitive that styles only `default` is a primitive each consumer has to finish, and the two
 * consumers finish it differently. `:focus-visible` is deliberately NOT transitioned: a focus ring
 * that fades in is a focus ring a keyboard user can miss.
 *
 * The rest props spread FIRST, so a caller cannot silently overwrite `data-state`, `disabled` or
 * `aria-busy` and leave the button claiming one thing and doing another.
 */
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
      {...rest}
      className={classes.join(" ")}
      data-state={state}
      disabled={disabled || state === "loading"}
      aria-busy={state === "loading" || undefined}
    >
      {children}
    </button>
  );
}
