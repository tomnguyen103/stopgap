import type { ReactNode } from "react";
import type { Role } from "@stopgap/core";
import { rolesAllow } from "../lib/authz";
import { Button, type ButtonProps } from "./ui";

/**
 * A control the caller may not use — rendered DISABLED, saying what it would take, never hidden
 * (ticket 03).
 *
 * Hiding is the tempting default and it is the wrong one twice over. It teaches a pharmacist that
 * the button does not exist rather than that they lack the role, so the support question becomes
 * "the approve button is broken" instead of "who can approve this". And it invites the reader to
 * believe the absence IS the enforcement, which it never is: the server action calls `requireRole`
 * regardless, and would refuse a hand-crafted request whatever this component rendered.
 *
 * So this is a LABEL, not a gate. The gate is server-side and unchanged.
 */
export function RoleGatedButton({
  roles,
  requires,
  children,
  ...rest
}: Omit<ButtonProps, "disabled"> & {
  /** The caller's roles. */
  roles: readonly Role[];
  /** The minimum role this control's action requires. */
  requires: Role;
  children: ReactNode;
}) {
  const allowed = rolesAllow([...roles], requires);
  return (
    <Button
      {...rest}
      disabled={!allowed}
      // `title` and the accessible name both carry the reason: a tooltip alone is invisible to a
      // screen reader, and a disabled control with no explanation is indistinguishable from a bug.
      title={allowed ? undefined : `Requires the ${requires.replace(/_/g, " ")} role`}
      aria-describedby={undefined}
    >
      {children}
      {allowed ? null : <span className="sub"> · requires {requires.replace(/_/g, " ")}</span>}
    </Button>
  );
}
