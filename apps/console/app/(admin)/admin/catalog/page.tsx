import Link from "next/link";
import { isDemoMode } from "@stopgap/demo";

import { Badge, Button, Card, Table } from "../../../components/ui";
import { isActionAllowed } from "../../../lib/authz";
import { unavailableReason } from "../../../lib/case-queue";
import {
  isSoleSourced,
  isUnsourced,
  parseCatalogListParams,
  CATALOG_LIST_SCHEMA,
  UPLOAD_KINDS,
} from "../../../lib/catalog-list";
import { getCatalogPage } from "../../../lib/data";
import { requireGroup } from "../../../lib/group-guard";
import {
  filterValue,
  listHref,
  pageCount,
  sortHref,
  toggleFilterHref,
} from "../../../lib/list-href";
import { resolvePrincipal } from "../../../lib/principal";
import { ImportPanel } from "./import-panel";

export const dynamic = "force-dynamic";

/**
 * The facility catalog — load it, browse it, and see what has only one way in (ticket 17).
 *
 * Guards itself, and does not rely on the group layout having run: a layout is not an
 * authorization boundary, because Next does not re-render one on a soft navigation.
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireGroup("admin");
  const params = parseCatalogListParams(await searchParams);
  const [catalog, principal] = await Promise.all([
    getCatalogPage({
      q: params.q,
      sourcing: filterValue(params, "sourcing"),
      sort: params.sort,
      dir: params.dir,
      page: params.page,
      pageSize: params.pageSize,
    }),
    resolvePrincipal(),
  ]);
  const pages = pageCount(catalog.total, params.pageSize);
  const reason = unavailableReason(
    isActionAllowed(principal.roles, "manage_catalog"),
    "admin",
    isDemoMode(),
  );

  return (
    <>
      <h1>Catalog</h1>
      <p className="sub">
        {catalog.total} item{catalog.total === 1 ? "" : "s"} · what this facility actually stocks
      </p>

      <Card title="Load a file" sub="CSV, one kind at a time, refused as a whole if any row fails">
        <ImportPanel kinds={UPLOAD_KINDS} unavailableReason={reason} />
      </Card>

      <Card title="Items" sub="Search by name, SKU or generic name">
        <form className="ds-filters" method="get" role="search">
          <label className="sub" htmlFor="catalog-q">
            Search the catalog
          </label>
          <input
            className="ds-input"
            id="catalog-q"
            name="q"
            type="search"
            defaultValue={params.q ?? ""}
            placeholder="cefazolin, SKU-0042 …"
          />
          {Object.entries(params.filters).flatMap(([key, values]) =>
            values.map((value) => (
              <input key={`${key}:${value}`} type="hidden" name={key} value={value} />
            )),
          )}
          <input type="hidden" name="sort" value={params.sort} />
          <input type="hidden" name="dir" value={params.dir} />
          <Button type="submit">Search</Button>
        </form>

        <div className="ds-chips">
          <span className="sub">sourcing</span>
          {CATALOG_LIST_SCHEMA.filters.sourcing?.map((value) => {
            const active = (params.filters.sourcing ?? []).includes(value);
            return (
              <Link
                key={value}
                className={active ? "ds-chip ds-chip--on" : "ds-chip"}
                href={toggleFilterHref(params, "sourcing", value, CATALOG_LIST_SCHEMA)}
                aria-current={active ? "true" : undefined}
              >
                {value === "sole"
                  ? "sole-sourced"
                  : value === "multi"
                    ? "more than one site"
                    : "no supplier loaded"}
              </Link>
            );
          })}
        </div>

        {catalog.rows.length === 0 ? (
          <p className="sub sub-tight">
            {catalog.total === 0 && params.q === null
              ? "No catalog loaded yet. Until one is, two of the three score components stay dark."
              : "No item matches this view."}{" "}
            <Link href="?">Clear filters</Link>
          </p>
        ) : (
          <Table
            label="Catalog items"
            head={[
              <Link key="name" href={sortHref(params, "name", CATALOG_LIST_SCHEMA)}>
                Item
              </Link>,
              <Link key="sku" href={sortHref(params, "sku", CATALOG_LIST_SCHEMA)}>
                SKU
              </Link>,
              <Link key="suppliers" href={sortHref(params, "suppliers", CATALOG_LIST_SCHEMA)}>
                Supplier sites
              </Link>,
              "On hand",
            ]}
          >
            {catalog.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/admin/catalog/${encodeURIComponent(row.sku)}`}>{row.name}</Link>
                  {row.genericName ? <div className="sub">{row.genericName}</div> : null}
                </td>
                <td className="sub">{row.sku}</td>
                <td>
                  {row.supplierSiteCount}
                  {isSoleSourced(row.supplierSiteCount) ? (
                    // The one fact this list exists to surface: a shortage of a sole-sourced item
                    // has no second route around it.
                    <>
                      {" "}
                      <Badge severity="high">sole-sourced</Badge>
                    </>
                  ) : isUnsourced(row.supplierSiteCount) ? (
                    // A different problem with a different fix: nothing is known about how this
                    // item is supplied, which is a gap in the file rather than a supply fact.
                    <>
                      {" "}
                      <Badge severity="moderate">no supplier loaded</Badge>
                    </>
                  ) : null}
                </td>
                <td>
                  {row.onHand === null ? (
                    <span className="sub">no inventory loaded</span>
                  ) : (
                    <>
                      {row.onHand}
                      {row.unit ? <span className="sub"> {row.unit}</span> : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}

        <nav className="ds-pager" aria-label="Catalog pages">
          {catalog.page > 1 ? (
            <Link
              className="ds-button ds-button--quiet"
              href={listHref(params, { page: catalog.page - 1 }, CATALOG_LIST_SCHEMA)}
            >
              Previous
            </Link>
          ) : (
            <span className="ds-button ds-button--quiet is-inert">Previous</span>
          )}
          <span className="sub">
            Page {catalog.page} of {pages}
          </span>
          {catalog.page < pages ? (
            <Link
              className="ds-button ds-button--quiet"
              href={listHref(params, { page: catalog.page + 1 }, CATALOG_LIST_SCHEMA)}
            >
              Next
            </Link>
          ) : (
            <span className="ds-button ds-button--quiet is-inert">Next</span>
          )}
        </nav>
      </Card>
    </>
  );
}
