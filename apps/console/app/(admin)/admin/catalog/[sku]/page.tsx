import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge, Card, Table } from "../../../../components/ui";
import { isSoleSourced } from "../../../../lib/catalog-list";
import { getCatalogItemDetail } from "../../../../lib/data";
import { requireGroup } from "../../../../lib/group-guard";
import { bandSeverity } from "../../../../lib/signal-list";

export const dynamic = "force-dynamic";

/**
 * One catalog item: what it is called, how it is identified, who supplies it, how much is on the
 * shelf, and which signals name it (ticket 17).
 *
 * The signals list is the item's own answer to "why is this on a risk list" — matched by the
 * identifiers the item actually carries, the same hints the poll's matcher reads.
 */
export default async function CatalogItemPage({ params }: { params: Promise<{ sku: string }> }) {
  await requireGroup("admin");
  const { sku } = await params;
  // The segment arrives percent-encoded (a SKU may contain a slash-free but reserved character),
  // and `decodeURIComponent` throws on a lone `%` — a hand-typed address must be a miss, not a 500.
  let decoded = sku;
  try {
    decoded = decodeURIComponent(sku);
  } catch {
    decoded = sku;
  }
  const detail = await getCatalogItemDetail(decoded);
  if (!detail) notFound();
  const { item, identifiers, suppliers, inventory, signals } = detail;
  const siteCount = new Set(suppliers.map((s) => s.site ?? s.name)).size;

  return (
    <>
      <p className="sub">
        <Link href="/admin/catalog">← Catalog</Link>
      </p>
      <h1>{item.name}</h1>
      <p className="sub">
        SKU {item.sku}
        {item.genericName ? ` · ${item.genericName}` : ""}
        {item.unit ? ` · ${item.unit}` : ""}
        {isSoleSourced(siteCount) ? (
          <>
            {" · "}
            <Badge severity="high">sole-sourced</Badge>
          </>
        ) : null}
      </p>

      <Card title="Identifiers" sub="What this item is called by the systems outside this one">
        {identifiers.length === 0 ? (
          <p className="sub sub-tight">
            None loaded. Without an NDC or an RxCUI a signal can only match this item by name, which
            is the weakest of the three hints.
          </p>
        ) : (
          <Table label="Item identifiers" head={["Kind", "Value"]}>
            {identifiers.map((row) => (
              <tr key={`${row.kind}:${row.value}`}>
                <td>{row.kind}</td>
                <td className="sub">{row.value}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Suppliers" sub={`${siteCount} distinct site${siteCount === 1 ? "" : "s"}`}>
        {suppliers.length === 0 ? (
          <p className="sub sub-tight">No supplier loaded for this item.</p>
        ) : (
          <Table label="Item suppliers" head={["Supplier", "Code", "Preferred"]}>
            {suppliers.map((row) => (
              <tr key={`${row.name}:${row.site ?? ""}`}>
                <td>{row.name}</td>
                <td className="sub">{row.code ?? "—"}</td>
                <td>{row.preferred ? "yes" : <span className="sub">no</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Inventory" sub="Most recent readings first">
        {inventory.length === 0 ? (
          <p className="sub sub-tight">
            No inventory loaded. The days-on-hand score component stays dark for this item until it
            is.
          </p>
        ) : (
          <Table label="Inventory readings" head={["On hand", "Captured"]}>
            {inventory.map((row) => (
              <tr key={row.capturedAt.toISOString()}>
                <td>
                  {row.onHand}
                  {row.unit ? <span className="sub"> {row.unit}</span> : null}
                </td>
                <td className="sub">{row.capturedAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Signals naming this item" sub="Why it appears on a risk list">
        {signals.length === 0 ? (
          <p className="sub sub-tight">No signal currently names this item.</p>
        ) : (
          <Table label="Matched signals" head={["Signal", "Domain", "Severity"]}>
            {signals.map((signal) => (
              <tr key={signal.dedupeKey}>
                <td>
                  <Link href={`/signals/${encodeURIComponent(signal.dedupeKey)}`}>
                    {signal.title}
                  </Link>
                </td>
                <td>{signal.riskDomain}</td>
                <td>
                  <Badge severity={bandSeverity(signal.severity)}>{signal.severity}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
