import { verifyAnchors } from "../anchors.js";
import { verifyAuditChain } from "../audit.js";
import { assertMaintenanceRoleBypassesRls, closeDb } from "../client.js";
import { withBypassDb } from "../org-context.js";
import { listOrganizations } from "../orgs.js";

/**
 * Headless audit-integrity check (PHASE6 §6.2). Recomputes the hash chain and cross-checks
 * every stored anchor against the live chain head. Exits non-zero if either fails, so it can
 * gate a deploy or run from cron.
 *
 *   pnpm verify-audit
 */
async function main() {
  // Cross-org by construction (PHASE6 §6.5): the chain is per-tenant, so "is the audit log
  // intact?" is N questions, and a check that silently only asked one of them would report green
  // while another hospital's history was rewritten. Runs through `withBypassDb` — the named escape
  // hatch — on the maintenance pool (`DATABASE_URL_MAINTENANCE`, a role holding BYPASSRLS).
  //
  // THE GUARD IS THE POINT, not a formality. Under an ordinary org-scoped role every per-org query
  // returns zero rows, so this script prints "chains OK (N org(s))", "0 db-mismatch, 0
  // EXTERNAL-mismatch" and "all good", exits 0, and gates a deploy — having verified nothing. A
  // green integrity check that examined no rows is worse than no check at all, because someone
  // acts on it. So it fails loudly here instead.
  await assertMaintenanceRoleBypassesRls("verify-audit");
  const orgs = await withBypassDb(() => listOrganizations());
  const chains = await withBypassDb(async (d) =>
    Promise.all(orgs.map(async (o) => ({ org: o, result: await verifyAuditChain(d, o.id) }))),
  );
  const broken = chains.filter((c) => !c.result.ok);
  const chain = { ok: broken.length === 0 };
  // Anchors are per-org too since migration 0014, so this check is also cross-tenant and runs on
  // the same bypass connection: `verifyAnchors` without an `orgId` covers every organization's
  // anchors, and each is compared against ITS OWN chain rather than against whichever tenant
  // happened to write `audit_log`'s highest id.
  const anchors = await withBypassDb((d) => verifyAnchors(d));
  // An EXTERNAL mismatch (the outside-the-DB anchor file disagrees with the live chain) is the
  // strong signal — a DB-write attacker cannot patch the file — so it is flagged distinctly
  // from a DB-internal-only mismatch.
  const externalMismatch = anchors.filter((a) => a.externalMatches === false);
  const dbMismatch = anchors.filter((a) => !a.headMatches);

  if (chain.ok) {
    console.log(`[verify-audit] chains OK (${String(orgs.length)} org(s))`);
  } else {
    for (const c of broken) {
      console.error(
        `[verify-audit] chain BROKEN for org ${c.org.slug} at row ${String(c.result.brokenAtId)} (${c.result.reason ?? "unknown"})`,
      );
    }
  }
  console.log(
    `[verify-audit] anchors: ${String(anchors.length)} checked, ${String(dbMismatch.length)} db-mismatch, ${String(externalMismatch.length)} EXTERNAL-mismatch`,
  );
  for (const a of externalMismatch) {
    console.error(
      `[verify-audit]   anchor #${String(a.id)} org ${a.orgId} head@${String(a.maxAuditId)} EXTERNAL FILE DISAGREES — live chain was rewritten`,
    );
  }
  for (const a of dbMismatch) {
    console.error(
      `[verify-audit]   anchor #${String(a.id)} org ${a.orgId} head@${String(a.maxAuditId)} no longer matches (db)`,
    );
  }

  await closeDb();
  if (!chain.ok || dbMismatch.length > 0 || externalMismatch.length > 0) process.exit(1);
  console.log("[verify-audit] all good");
}

main().catch((err) => {
  console.error("[verify-audit] failed:", err);
  process.exit(1);
});
