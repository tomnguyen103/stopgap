import type { HTMLAttributes, ReactNode } from "react";

// `title` on an HTML element is the tooltip attribute — a string. A card's title is a heading and
// may be any node, so the DOM attribute is dropped rather than widened; a caller that genuinely
// wants a tooltip can still pass `aria-label`.
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** Secondary line under the title — the console's established `.sub` voice. */
  sub?: ReactNode;
  children: ReactNode;
}

/** The panel the console has always drawn, expressed once. */
export function Card({ title, sub, className, children, ...rest }: CardProps) {
  return (
    <section {...rest} className={className ? `ds-card ${className}` : "ds-card"}>
      {title ? <h2 className="ds-card__title">{title}</h2> : null}
      {sub ? <p className="ds-card__sub">{sub}</p> : null}
      {children}
    </section>
  );
}
