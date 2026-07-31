import type { ReactNode, TableHTMLAttributes } from "react";

/**
 * A heading that is also a sort control.
 *
 * `aria-sort` belongs on the `<th>`, not on the link inside it, so the primitive has to be told —
 * a caller cannot reach the cell. Built through `sortable()` rather than by structural detection:
 * a React element is an object too, and sniffing for a `content` key would misread one.
 */
export interface SortableHead {
  __sortable: true;
  content: ReactNode;
  sort: "ascending" | "descending" | "none";
}

/** Marks a heading as sorted, so the `<th>` can carry `aria-sort`. */
export function sortable(content: ReactNode, sort: SortableHead["sort"]): SortableHead {
  return { __sortable: true, content, sort };
}

function isSortable(cell: ReactNode | SortableHead): cell is SortableHead {
  return typeof cell === "object" && cell !== null && "__sortable" in cell;
}

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Column headings, in order. Wrap one in `sortable()` to carry `aria-sort`. */
  head: (ReactNode | SortableHead)[];
  /** Names the scroll region for a screen reader — required, because an unnamed one is noise. */
  label: string;
  children: ReactNode;
}

/**
 * The console's table, inside its own scroll container.
 *
 * The container is the one place a primitive does MORE than the markup it replaces, and it earns
 * it: a five-column table cannot fit a 375px viewport, and left alone it pushes the whole PAGE
 * sideways rather than scrolling itself. Desktop is unaffected — the content fits, so the
 * container never scrolls and nothing moves.
 *
 * It is focusable and labelled because a scrollable region that only a mouse can reach is a
 * region a keyboard user cannot read (WCAG 2.1.1).
 */
export function Table({ head, label, className, children, ...rest }: TableProps) {
  return (
    <div className="ds-table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table {...rest} className={className ? `ds-table ${className}` : "ds-table"}>
        <thead>
          <tr>
            {head.map((cell, i) => (
              // Headings are static per call site and carry no identity of their own; the index
              // IS the column, which is the one case where it is the honest key.
              <th key={i} scope="col" aria-sort={isSortable(cell) ? cell.sort : undefined}>
                {isSortable(cell) ? cell.content : cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
