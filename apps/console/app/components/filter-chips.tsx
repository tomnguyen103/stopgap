import Link from "next/link";

/**
 * Human names for the filter groups.
 *
 * `/overview` and `/queue` rendered the SCHEMA KEY as the group heading — "domain", "freshness",
 * "status" — which is the shape of the parser leaking onto a clinical surface. "freshness" in
 * particular means nothing to a pharmacist until it says what is fresh.
 */
const FILTER_LABELS: Record<string, string> = {
  domain: "Risk domain",
  severity: "Severity",
  freshness: "Signal freshness",
  status: "Case status",
};

/** Falls back to the key rather than throwing: a filter added later renders, it just reads oddly. */
export function filterLabel(key: string): string {
  return FILTER_LABELS[key] ?? key;
}

/**
 * One filter group.
 *
 * `role="group"` with an `aria-label`, because the heading beside the chips was a bare `<span>`:
 * visually it grouped them, programmatically it grouped nothing, so a screen reader met a run of
 * links with no idea which axis they belonged to.
 */
export function FilterChips({
  groupKey,
  allowed,
  active,
  hrefFor,
}: {
  groupKey: string;
  allowed: readonly string[];
  active: readonly string[];
  hrefFor: (value: string) => string;
}) {
  const label = filterLabel(groupKey);
  return (
    <div className="ds-chips" role="group" aria-label={label}>
      <span className="ds-chips__label">{label}</span>
      {allowed.map((value) => {
        const on = active.includes(value);
        return (
          <Link
            key={value}
            className={on ? "ds-chip ds-chip--on" : "ds-chip"}
            href={hrefFor(value)}
            /* A link is not a button: `aria-pressed` is not valid on `role=link`, and what is
               being announced is "this is the view you are on". */
            aria-current={on ? "true" : undefined}
          >
            {value}
          </Link>
        );
      })}
    </div>
  );
}
