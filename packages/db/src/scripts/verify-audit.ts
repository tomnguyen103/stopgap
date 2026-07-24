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
  // An EXTERNAL mismatch (the outside-the-DB anchor file disagrees with the live chain) is the
  // strong signal — a DB-write attacker cannot patch the file — so it is flagged distinctly
  // from a DB-internal-only mismatch.
  const externalMismatch = anchors.filter((a) => a.externalMatches === false);
  const dbMismatch = anchors.filter((a) => !a.headMatches);

  if (chain.ok) {
    console.log("[verify-audit] chain OK");
  } else {
    console.error(`[verify-audit] chain BROKEN at row ${String(chain.brokenAtId)} (${chain.reason ?? "unknown"})`);
  }
  console.log(
    `[verify-audit] anchors: ${String(anchors.length)} checked, ${String(dbMismatch.length)} db-mismatch, ${String(externalMismatch.length)} EXTERNAL-mismatch`,
  );
  for (const a of externalMismatch) {
    console.error(
      `[verify-audit]   anchor #${String(a.id)} head@${String(a.maxAuditId)} EXTERNAL FILE DISAGREES — live chain was rewritten`,
    );
  }
  for (const a of dbMismatch) {
    console.error(`[verify-audit]   anchor #${String(a.id)} head@${String(a.maxAuditId)} no longer matches (db)`);
  }

  await closeDb();
  if (!chain.ok || dbMismatch.length > 0 || externalMismatch.length > 0) process.exit(1);
  console.log("[verify-audit] all good");
}

main().catch((err) => {
  console.error("[verify-audit] failed:", err);
  process.exit(1);
});
