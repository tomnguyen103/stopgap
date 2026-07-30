import type { ReactNode } from "react";
import type { Role } from "@stopgap/core";
import { rolesAllow } from "../lib/authz";
import { Button, type ButtonProps } from "./ui";

/**
 * A control the caller may not use — rendered DISABLED, saying what it would take, never hidden
 * (ticket 03).
 *
 * Hiding is the tempting default and it is wrong twice over. It teaches a pharmacist that the
 * button does not exist rather than that they lack the role, so the support question becomes "the
 * approve button is broken" instead of "who can approve this". And it invites the reader to
 * believe the absence IS the enforcement, which it never is: the server action calls `requireRole`
 * regardless and refuses a hand-crafted request whatever this renders.
 *
 * So this is a LABEL. The gate is server-side and unchanged.
 *
 * `aria-disabled` rather than `disabled`, and a handler that no-ops: a genuinely disabled control
 * leaves the tab order, which puts the very explanation a keyboard or screen-reader user needs out
 * of their reach — and browsers do not fire `title` tooltips on disabled elements either. The
 * reason is therefore in the accessible name as well as the tooltip.
 */
export function RoleGatedButton({
  roles,
  requires,
  children,
  onClick,
  ...rest
}: Omit<ButtonProps, "disabled"> & {
  /** The caller's roles. */
  roles: readonly Role[];
  /** The minimum role this control's action requires. */
  requires: Role;
  children: ReactNode;
}) {
  const allowed = rolesAllow(roles, requires);
  const reason = `Requires the ${requires.replace(/_/g, " ")} role`;
  // Only a STRING child can go in the accessible name. `String(children)` on an element renders
  // "[object Object]", which reads out as exactly that — worse than the label the button would
  // have had from its own content. When the child is not a string the reason stands alone and the
  // content still names the control.
  const label = typeof children === "string" ? `${children} — ${reason}` : reason;
  return (
    <Button
      {...rest}
      aria-disabled={!allowed || undefined}
      title={allowed ? undefined : reason}
      aria-label={allowed ? undefined : label}
      // Dropping the handler is not enough to refuse the control. `Button` renders a bare
      // `<button>`, which inside a form is `type="submit"` by default, so a denied button would
      // still submit the form it sits in — by click and by Enter on focus. `aria-disabled` refuses
      // it to assistive tech but, unlike `disabled`, does not stop the native action.
      //
      // `type="button"` rather than a handler that cancels the event: it removes the submit
      // behaviour structurally instead of relying on a cancellation that a wrapper could intercept,
      // and it leaves the denied branch passing NO function — so this stays renderable from a server
      // component, which a handler would break. The control keeps its place in the tab order, where
      // the reason can still be read.
      type={allowed ? rest.type : "button"}
      onClick={allowed ? onClick : undefined}
    >
      {children}
      {allowed ? null : <span className="sub"> · {reason.toLowerCase()}</span>}
    </Button>
  );
}
