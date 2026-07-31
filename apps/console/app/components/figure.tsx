import { Sparkline } from "./sparkline";

/**
 * A headline number.
 *
 * §6's second-order mark: the figure gets the largest type on the page and its label sits beneath
 * in Micro uppercase, rather than a big number over a 13px sentence — which reads as a caption
 * under a heading instead of as a measurement.
 *
 * Shared rather than declared locally on each surface. It already existed twice, byte-identical,
 * on `/overview` and `/oversight`; the moment one of them gained a sparkline the two stopped
 * agreeing about what a figure looks like, which is the whole argument for a design system.
 */
export function Figure({
  label,
  value,
  spark,
  sparkLabel,
}: {
  label: string;
  value: number;
  /** A 14-day series, when one exists for this figure. */
  spark?: number[];
  /**
   * Names which series the sparkline draws — REQUIRED alongside `spark`, because it is rarely the
   * figure's own history and a reader will assume it is unless told.
   */
  sparkLabel?: string;
}) {
  return (
    <div className="ds-figure">
      <div className="ds-figure__value">{value}</div>
      <div className="ds-figure__label">{label}</div>
      {spark && sparkLabel ? (
        <>
          <Sparkline points={spark} />
          <p className="ds-figure__caption">{sparkLabel}</p>
        </>
      ) : null}
    </div>
  );
}
