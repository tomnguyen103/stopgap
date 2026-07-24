/**
 * Resolve an exception-queue case from the command line (until the Phase 4 review UI exists).
 * The resolution becomes an approved protocol version and the case continues.
 *
 *   pnpm --filter @stopgap/workflows resolve-exception "<key>" "<protocol text>" "<alternative>" "<rationale>"
 */
import { workflowIdForKey } from "@stopgap/db";
import { makeClient } from "../client.js";
import { exceptionResolvedSignal } from "../workflows.js";

const [key, protocolBody, alternative, rationale] = process.argv.slice(2);
if (!key || !protocolBody) {
  console.error('usage: resolve-exception "<key>" "<protocol text>" [alternative] [rationale]');
  process.exit(1);
}

const { client, connection } = await makeClient();
const handle = client.workflow.getHandle(workflowIdForKey(key));
await handle.signal(exceptionResolvedSignal, {
  protocolBody,
  alternatives: alternative ? [alternative] : [],
  resolvedBy: process.env.STOPGAP_USER ?? "pharmacist-cli",
  rationale: rationale ?? "Resolved from the exception queue.",
});
console.log(`[resolve-exception] signalled ${workflowIdForKey(key)}`);
await connection.close();
