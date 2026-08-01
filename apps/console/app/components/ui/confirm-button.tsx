"use client";

import { useRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";

/**
 * A destructive action behind a confirmation that names its target.
 *
 * Revoke and Disable were single-click and irreversible from the console — revoking the wrong API
 * key breaks an integration until someone reissues it, and until P4.1 disabling the wrong account
 * could only be undone by hand in SQL. Neither said WHICH row it was about to act on, and both sat
 * in a table where the rows differ by one word.
 *
 * A native `<dialog>`, so the focus trap, the Escape key and the top-layer stacking are the
 * platform's rather than this component's. It reuses the drawer's elevation, because it is the
 * same kind of surface: something floating over content that is still there.
 */
export function ConfirmButton({
  target,
  action,
  confirmLabel,
  description,
  children,
  ...rest
}: Omit<ButtonProps, "onClick"> & {
  /** What the action is about to happen TO, shown verbatim in the dialog. */
  target: string;
  /** The confirming button's label — the verb, not "OK". */
  confirmLabel: string;
  /** What the action does, in one sentence. */
  description: ReactNode;
  action: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <Button
        {...rest}
        type="button"
        onClick={() => {
          dialog.current?.showModal();
        }}
      >
        {children}
      </Button>
      <dialog className="ds-drawer ds-confirm" ref={dialog}>
        <h2 className="ds-card__title">{confirmLabel}</h2>
        <p>{description}</p>
        <p>
          <span className="mono">{target}</span>
        </p>
        <div className="actions">
          {/* The cancel is FIRST and the confirm is the danger variant, so the safe option is the
              one under the cursor and the destructive one has to be aimed at. */}
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              dialog.current?.close();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              dialog.current?.close();
              action();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </>
  );
}
