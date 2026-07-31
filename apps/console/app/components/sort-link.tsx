import Link from "next/link";
import { sortable, type SortableHead } from "./ui/table";

/**
 * A sortable column heading.
 *
 * `/overview` had this and `/queue` did not: the queue's headers were bare `<Link>`s, so a
 * pharmacist could sort the list but nothing on screen said which column was sorted, or which way.
 * On the surface where a queue's ORDER is the whole point, that is the affordance missing.
 *
 * Returns a `sortable()` head cell rather than an element, because `aria-sort` belongs on the
 * `<th>` and a caller cannot reach the cell the primitive renders.
 */
export function sortHead({
  href,
  label,
  active,
  dir,
}: {
  href: string;
  label: string;
  active: boolean;
  dir: "asc" | "desc";
}): SortableHead {
  return sortable(
    <Link href={href}>
      {label}
      {/* The arrow is decorative: `aria-sort` on the cell already says the same thing, and a
          screen reader announcing both would say it twice. */}
      {active ? <span aria-hidden="true">{dir === "asc" ? " ↑" : " ↓"}</span> : null}
    </Link>,
    active ? (dir === "asc" ? "ascending" : "descending") : "none",
  );
}
