import { SEED_ORG_ID, getCaseByKey, withOrgDb } from "@stopgap/db";
import { pollOpenFda } from "@stopgap/ingest";
import { makeClient, startCase } from "../client.js";

/**
 * End-to-end Phase-1 driver: poll the live openFDA feed (or a `search` arg), open a durable
 * case for the first current shortage, and print its workflow id. Watch it run in the
 * Temporal UI (http://localhost:8233) and the console (http://localhost:3000).
 *
 *   pnpm --filter @stopgap/workflows start-case "heparin"
 *   STOPGAP_ORG_ID=<uuid> pnpm --filter @stopgap/workflows start-case "heparin"
 *
 * A CLI has no session, so the tenant comes from `STOPGAP_ORG_ID` and defaults to the seed org —
 * the one migration 0013 backfilled every pre-multi-tenancy row into, and the one the local
 * compose stack and demo map to. Defaulting is honest HERE (unlike in a request path) because the
 * operator running this command is choosing the deployment they are pointed at.
 */
async function main() {
  const search = process.argv[2];
  const records = await pollOpenFda({
    search: search ? `generic_name:"${search}"` : undefined,
    limit: 10,
  });
  const record = records.find((r) => r.status === "current") ?? records[0];
  if (!record) {
    console.error("[start-case] no shortage records returned from openFDA");
    process.exit(1);
  }
  const orgId = process.env.STOPGAP_ORG_ID ?? SEED_ORG_ID;
  const { client, connection } = await makeClient();
  // Reuse the id an existing case row already carries: a case opened before the org-qualified
  // format answers only to `case-<key>`, and minting a new id would fork it into two workflows.
  const existing = await withOrgDb(orgId, (db) => getCaseByKey(db, orgId, record.key));
  const { workflowId, started } = await startCase(
    client,
    orgId,
    record,
    [record.source],
    existing?.workflowId,
  );
  console.log(
    `[start-case] ${started ? "opened" : "already open"}: case ${workflowId} for "${record.genericName}" (${record.key})`,
  );
  await connection.close();
}

main().catch((err) => {
  console.error("[start-case] failed:", err);
  process.exit(1);
});
