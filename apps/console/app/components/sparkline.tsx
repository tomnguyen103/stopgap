/**
 * Fourteen points, drawn beside a figure.
 *
 * NO CHART LIBRARY, for the same reason `TrendChart` has none: fourteen points is less code than
 * the adapter that would wire a library into a server component, and it ships no JavaScript for a
 * picture that never changes after render.
 *
 * IT IS NOT THE FIGURE'S OWN HISTORY, and the caller's caption says so. "Open cases" is a level —
 * how many are open right now — while `DailyCount.casesOpened` is a flow, how many opened each
 * day. Drawing a flow under a level and letting the reader assume they are the same series is the
 * most common way a sparkline lies.
 *
 * `aria-hidden` and NO `title`: the caption beneath the figure already carries the same words, so
 * a tooltip and an announcement would both repeat it. A fourteen-point polyline has nothing to
 * say that its caption does not.
 */
export function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;

  const width = 96;
  const height = 20;
  const peak = Math.max(1, ...points);
  const step = width / (points.length - 1);
  const path = points
    .map(
      (value, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(height - (value / peak) * height).toFixed(1)}`,
    )
    .join(" ");

  return (
    <span className="ds-spark">
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
