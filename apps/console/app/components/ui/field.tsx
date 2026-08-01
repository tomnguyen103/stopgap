import { useId, type ReactNode } from "react";

export interface FieldProps {
  /** The visible label. Not optional — a control without one is the bug this component closes. */
  label: ReactNode;
  /** Secondary guidance, associated with the control rather than floating beside it. */
  hint?: ReactNode;
  /**
   * Renders the control. Receives the id the label points at, and the id of the hint when there
   * is one, so the caller wires `id` and `aria-describedby` from values it cannot get wrong.
   */
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/**
 * A labelled control.
 *
 * The review textarea — where a pharmacist writes the protocol a floor will follow — had no
 * accessible name at all, and four fields around it used their placeholder as their label. A
 * placeholder is not a label: it disappears on the first keystroke, so someone mid-sentence has
 * nothing on screen telling them which box they are in, and a screen reader returning to a filled
 * field announces an unnamed textbox.
 *
 * The id comes from `useId`, not from the caller, because two of these render inside a `.map` and
 * a hand-written id would collide the moment a second one appeared.
 */
export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="ds-field">
      <label className="ds-field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="ds-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children(id, hintId)}
    </div>
  );
}
