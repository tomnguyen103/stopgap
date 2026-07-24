import { verifyAnchors } from "../anchors.js";
import { verifyAuditChain } from "../audit.js";
import { closeDb, getDb } from "../client.js";

/**
 * Headless audit-integrity check (PHASE6 §6.2). Recomputes the hash chain and cross-checks
 * every stored anchor against the live chain head. Exits non-zero if either fails, so it can
 * gate a deploy or run from cron.
 *
 *   pnpm verify-audit
 */
async function main() {
  const db = getDb();
  const chain = await verifyAuditChain(db);
  const anchors = await verifyAnchors(db);
  const brokenAnchors = anchors.filter((a) => !a.headMatches);

  if (chain.ok) {
    console.log("[verify-audit] chain OK");
  } else {
    console.error(`[verify-audit] chain BROKEN at row ${String(chain.brokenAtId)} (${chain.reason ?? "unknown"})`);
  }
  console.log(
    `[verify-audit] anchors: ${String(anchors.length)} checked, ${String(brokenAnchors.length)} mismatched`,
  );
  for (const a of brokenAnchors) {
    console.error(`[verify-audit]   anchor #${String(a.id)} head@${String(a.maxAuditId)} no longer matches`);
  }

  await closeDb();
  if (!chain.ok || brokenAnchors.length > 0) process.exit(1);
  console.log("[verify-audit] all good");
}

main().catch((err) => {
  console.error("[verify-audit] failed:", err);
  process.exit(1);
});
