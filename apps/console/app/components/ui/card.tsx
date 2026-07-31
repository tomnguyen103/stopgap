import type { HTMLAttributes, ReactNode } from "react";

// `title` on an HTML element is the tooltip attribute — a string. A card's title is a heading and
// may be any node, so the DOM attribute is dropped rather than widened; a caller that genuinely
// wants a tooltip can still pass `aria-label`.
/** What a card can report about itself through the Ledger Rail (§6). */
export type CardState = "critical" | "attention" | "ok";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** Secondary line under the title — the console's established `.sub` voice. */
  sub?: ReactNode;
  /**
   * Tints the card's left rail.
   *
   * Set it ONLY when the card has a real state to report. A rail on every card is a rail that
   * says nothing; the untinted default is a hairline, which is the honest reading of "no state".
   * It never carries the meaning alone — the badge or figure inside still says what the state is,
   * which is what keeps it legible under `forced-colors` and to a colourblind reader.
   */
  state?: CardState;
  children: ReactNode;
}

/** The panel the console has always drawn, expressed once. */
export function Card({ title, sub, state, className, children, ...rest }: CardProps) {
  return (
    <section
      {...rest}
      data-state={state}
      className={className ? `ds-card ${className}` : "ds-card"}
    >
      {title ? <h2 className="ds-card__title">{title}</h2> : null}
      {sub ? <p className="ds-card__sub">{sub}</p> : null}
      {children}
    </section>
  );
}
