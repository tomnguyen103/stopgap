import { pollOpenFda } from "@stopgap/ingest";
import { makeClient, startCase } from "../client.js";

/**
 * End-to-end Phase-1 driver: poll the live openFDA feed (or a `search` arg), open a durable
 * case for the first current shortage, and print its workflow id. Watch it run in the
 * Temporal UI (http://localhost:8233) and the console (http://localhost:3000).
 *
 *   pnpm --filter @stopgap/workflows start-case "heparin"
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
  const { client, connection } = await makeClient();
  const { workflowId, started } = await startCase(client, record);
  console.log(
    `[start-case] ${started ? "opened" : "already open"}: case ${workflowId} for "${record.genericName}" (${record.key})`,
  );
  await connection.close();
}

main().catch((err) => {
  console.error("[start-case] failed:", err);
  process.exit(1);
});
