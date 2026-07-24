/**
 * Resolve an exception-queue case from the command line (until the Phase 4 review UI exists).
 * The resolution becomes an approved protocol version and the case continues.
 *
 *   pnpm --filter @stopgap/workflows resolve-exception "<key>" "<protocol text>" "<alternative>" "<rationale>"
 *
 * The tenant comes from `STOPGAP_ORG_ID`, defaulting to the seed org. The workflow id is read off
 * the CASE ROW rather than recomputed (PHASE6 §6.5): ids minted before the org-qualified format are
 * `case-<key>`, and a recomputed id would signal a workflow that does not exist — silently doing
 * nothing on the one command an operator uses to unblock a parked case.
 */
import { SEED_ORG_ID, getCaseByKey, withOrgDb } from "@stopgap/db";
import { makeClient } from "../client.js";
import { exceptionResolvedSignal } from "../workflows.js";

const [key, protocolBody, alternative, rationale] = process.argv.slice(2);
if (!key || !protocolBody) {
  console.error('usage: resolve-exception "<key>" "<protocol text>" [alternative] [rationale]');
  process.exit(1);
}

const orgId = process.env.STOPGAP_ORG_ID ?? SEED_ORG_ID;
const row = await withOrgDb(orgId, (db) => getCaseByKey(db, orgId, key));
if (!row) {
  console.error(`[resolve-exception] no case for key "${key}" in org ${orgId}`);
  process.exit(1);
}

const { client, connection } = await makeClient();
const handle = client.workflow.getHandle(row.workflowId);
await handle.signal(exceptionResolvedSignal, {
  protocolBody,
  alternatives: alternative ? [alternative] : [],
  resolvedBy: process.env.STOPGAP_USER ?? "pharmacist-cli",
  rationale: rationale ?? "Resolved from the exception queue.",
});
console.log(`[resolve-exception] signalled ${row.workflowId}`);
await connection.close();
