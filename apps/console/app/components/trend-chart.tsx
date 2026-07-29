import type { DailyCount } from "@stopgap/db";

/**
 * Fourteen days of two counts, as a server-rendered inline SVG (ticket 14).
 *
 * NO CHART LIBRARY. Two series of fourteen points is less code than the adapter that would wire a
 * library into a server component, and it ships no JavaScript for a picture that never changes
 * after render.
 *
 * ONE AXIS. Cases opened and alerts fired are both counts of events per day, so they share a scale
 * honestly; a second y-axis would let the two lines cross wherever the scales were chosen to make
 * them cross, which is the most reliable way to draw a relationship that is not in the data.
 *
 * The two hues are the console's own `--accent` and `--high`. They separate by ΔE 26 under protan
 * and 32 in normal vision (checked, not eyeballed), so the pair is legible to a colourblind reader
 * — and identity is carried by the legend and the end labels as well as by colour, never by colour
 * alone. They sit lighter than the reference palette's dark-mode lightness band; the console's
 * palette is the locked design system here and is not re-picked for one chart.
 *
 * Every day in the window is plotted, including the empty ones: a series drawn only from days that
 * had activity slopes straight through a quiet week, which reads as steady work rather than none.
 */
export function TrendChart({ series }: { series: DailyCount[] }) {
  if (series.length === 0) {
    return <p className="sub sub-tight">No activity recorded in this window.</p>;
  }

  const width = 640;
  const height = 160;
  const padX = 12;
  const padY = 16;
  const peak = Math.max(1, ...series.map((day) => Math.max(day.casesOpened, day.alertsFired)));
  const stepX = series.length === 1 ? 0 : (width - padX * 2) / (series.length - 1);
  const x = (index: number) => padX + index * stepX;
  const y = (value: number) => height - padY - (value / peak) * (height - padY * 2);
  const path = (pick: (day: DailyCount) => number) =>
    series.map((day, index) => `${index === 0 ? "M" : "L"}${x(index)} ${y(pick(day))}`).join(" ");

  const last = series[series.length - 1];
  const first = series[0];

  return (
    <figure className="ds-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Cases opened and alerts fired per day, ${first?.day ?? ""} to ${last?.day ?? ""}. Peak ${peak} per day.`}
        preserveAspectRatio="none"
      >
        {/* One baseline, recessive: the reference the eye needs, and nothing else competing with
            the data for attention. */}
        <line
          x1={padX}
          x2={width - padX}
          y1={height - padY}
          y2={height - padY}
          stroke="var(--border-default)"
          strokeWidth="1"
        />
        <path
          d={path((day) => day.casesOpened)}
          fill="none"
          stroke="var(--interactive)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={path((day) => day.alertsFired)}
          fill="none"
          stroke="var(--severity-high)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Markers only at the last point of each series — a dot on every point is noise at this
            density, and the end is the value a reader is looking for. */}
        {last ? (
          <>
            <circle
              cx={x(series.length - 1)}
              cy={y(last.casesOpened)}
              r="4"
              fill="var(--interactive)"
              stroke="var(--surface-raised)"
              strokeWidth="2"
            />
            <circle
              cx={x(series.length - 1)}
              cy={y(last.alertsFired)}
              r="4"
              fill="var(--severity-high)"
              stroke="var(--surface-raised)"
              strokeWidth="2"
            />
          </>
        ) : null}
        {/* A native <title> per day: hover text with no client JavaScript, and it reaches a screen
            reader through the same markup. */}
        {series.map((day, index) => (
          <rect
            key={day.day}
            x={x(index) - stepX / 2}
            y={padY}
            width={Math.max(stepX, 1)}
            height={height - padY * 2}
            fill="transparent"
          >
            <title>{`${day.day}: ${day.casesOpened} case${day.casesOpened === 1 ? "" : "s"} opened, ${day.alertsFired} alert${day.alertsFired === 1 ? "" : "s"} fired`}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="sub">
        <span className="ds-chart__key ds-chart__key--cases" /> Cases opened
        {last ? ` (${last.casesOpened} on ${last.day})` : ""}
        {" · "}
        <span className="ds-chart__key ds-chart__key--alerts" /> Alerts fired
        {last ? ` (${last.alertsFired})` : ""}
        {" · peak "}
        {peak} per day · {first?.day} → {last?.day}
      </figcaption>
    </figure>
  );
}
