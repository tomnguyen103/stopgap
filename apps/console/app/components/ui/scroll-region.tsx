"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A horizontally scrollable region that is focusable ONLY when it actually scrolls.
 *
 * A scroll container a keyboard user cannot reach is a region they cannot read (WCAG 2.1.1), which
 * is why `Table` made its wrapper focusable. But an unconditional `tabIndex={0}` puts a tab stop
 * in front of every table on every page including the ones that fit — so a pharmacist tabbing to
 * the first link in the queue passes through a stop that does nothing, on every table, forever.
 *
 * Measured rather than guessed: the same table scrolls at 375px and does not at 1440px, so this
 * re-checks on resize. `ResizeObserver` and not a `resize` listener, because the container's width
 * also changes when the rail switches breakpoint without the window changing size.
 */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      setScrollable(node.scrollWidth > node.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="ds-table-scroll"
      // The region is announced only when it IS one. An unscrollable div with `role="region"` and
      // a label is an announcement of nothing.
      role={scrollable ? "region" : undefined}
      aria-label={scrollable ? label : undefined}
      tabIndex={scrollable ? 0 : undefined}
    >
      {children}
    </div>
  );
}
