import { listCatalogItemsPage, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../../lib/api-auth";
import { parseApiListQuery, pageMeta } from "../../../../lib/api-list-query";
import { jsonOk } from "../../../../lib/api-response";
import { catalogItemListSchema, toCatalogItemResource } from "../../../../lib/api-schemas";

/**
 * `GET /api/v1/catalog/items` (ticket 19) — the facility's stocked items, scope `catalog:read`.
 *
 * Identity and units only. On-hand quantities, supplier links and contract prices are NOT in this
 * response: they are the inputs to the exposure reading, and a catalog list is read by planning
 * integrations that need to know WHAT a hospital stocks, not how little of it is left. Publishing
 * stock levels on the resource everyone reads would make the narrowest scope the most sensitive
 * one.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request, "catalog:read");
  if (!auth.ok) return auth.response;

  const query = parseApiListQuery("catalogItems", new URL(request.url));
  const orgId = auth.key.orgId;
  const page = await withOrgDb(orgId, (db) => listCatalogItemsPage(db, orgId, query));
  return jsonOk(
    catalogItemListSchema.parse({
      items: page.rows.map(toCatalogItemResource),
      page: pageMeta(query, page.total),
    }),
  );
}
