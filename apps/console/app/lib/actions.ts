"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isRole } from "@stopgap/core";
import {
  appendAudit,
  approveProtocolVersion,
  assignRole,
  getCaseByWorkflowId,
  getDb,
  revokeRole,
  setUserDisabled,
} from "@stopgap/db";
import { assertMutationAllowed, isDemoMode, prepareDemoRun, type DemoRunResult } from "@stopgap/demo";
import { resolveException, startCase, submitReview, withTemporalClient } from "@stopgap/workflows";
import { requireRole } from "./auth-guards";

/**
 * HITL actions (PROJECT_PLAN §2, §13 Phase 4). Every one of these signals the durable
 * workflow rather than writing case state directly: the workflow owns the state machine, so
 * a decision recorded straight into Postgres would be a lie the moment the workflow moved on.
 *
 * A server action is a public endpoint: anything reachable here is reachable by anyone who
 * can POST to this app. Two gates therefore run at the TOP of every mutation (PHASE6 §6.1):
 * `assertMutationAllowed` (the demo read-only gate) and `requireRole` (the RBAC matrix). The
 * reviewer/approver identity now comes from the authenticated session (`principal.userId`, a
 * real `users.id`), NEVER a client-supplied string, and is threaded through the workflow signal
 * into the tamper-evident audit chain.
 */

const reviewDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("edit"), editedDraft: z.string().min(1).max(20_000) }),
  z.object({ kind: z.literal("reject"), reason: z.string().min(1).max(2_000) }),
]);

const resolutionSchema = z.object({
  protocolBody: z.string().min(1).max(20_000),
  alternatives: z.array(z.string().min(1).max(200)).max(20),
  rationale: z.string().min(1).max(2_000),
});

const workflowIdSchema = z.string().min(1).max(200);

/** The dedup key behind a workflow id, so an action can address the case the page shows. */
async function keyForWorkflow(workflowId: string): Promise<string> {
  const row = await getCaseByWorkflowId(getDb(), workflowId);
  if (!row) throw new Error(`no case for workflow ${workflowId}`);
  return row.key;
}

export async function reviewCase(workflowId: string, decision: unknown): Promise<void> {
  // A public demo must not let a visitor approve clinical guidance; and only a pharmacist+
  // may review at all. Both gates fail the anonymous demo viewer — the same locked-down result.
  assertMutationAllowed("Approving or rejecting a case");
  const principal = await requireRole("review_case");
  const parsed = reviewDecisionSchema.parse(decision);
  const key = await keyForWorkflow(workflowIdSchema.parse(workflowId));
  await withTemporalClient((client) =>
    submitReview(client, key, parsed, principal.label, principal.userId ?? undefined),
  );
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/");
}

export async function resolveExceptionCase(workflowId: string, resolution: unknown): Promise<void> {
  assertMutationAllowed("Resolving an exception");
  const principal = await requireRole("resolve_exception");
  const parsed = resolutionSchema.parse(resolution);
  const key = await keyForWorkflow(workflowIdSchema.parse(workflowId));
  await withTemporalClient((client) =>
    resolveException(client, key, {
      ...parsed,
      resolvedBy: principal.label,
      resolvedByUserId: principal.userId ?? undefined,
    }),
  );
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/protocols");
}

/**
 * Record a privileged (non-case) action in the audit chain with the authenticated principal.
 * Shared by the protocol-approval and admin user actions, which otherwise repeat the same
 * actor/actorUserId/identitySource shape. These entries have no `caseId`, so `appendAudit` does
 * not dedupe on `eventKey` — the key is a stable, descriptive label (never a timestamp), and the
 * NULL `caseId` keeps rows distinct in the unique index so repeated grants/toggles each append.
 */
async function recordPrivilegedAudit(
  principal: { label: string; userId: string | null },
  action: string,
  detail: Record<string, unknown>,
  eventKey: string,
): Promise<void> {
  await appendAudit(getDb(), {
    actor: principal.label,
    actorUserId: principal.userId ?? undefined,
    action,
    detail: { ...detail, identitySource: "authenticated-session" },
    eventKey,
  });
}

/**
 * Approve a drafted protocol version directly (PHASE6 §6.1 matrix). Distinct from `reviewCase`:
 * this is the pharmacy-director capability to approve/supersede a version outside a case's HITL
 * gate, so it is gated one rank higher (`approve_protocol_version` → `pharmacy_director`). A
 * pharmacist calling it fails server-side with `AuthorizationError`. The approval lands in the
 * audit chain with the authenticated approver's `users.id`.
 */
export async function approveProtocolVersionAction(versionId: unknown): Promise<void> {
  assertMutationAllowed("Approving a protocol version");
  const principal = await requireRole("approve_protocol_version");
  const id = z.string().uuid().parse(versionId);
  const { row, changed } = await approveProtocolVersion(id, principal.label, principal.userId ?? undefined);
  // Skip the audit entry when the version was already approved (no-op): recording it would put a
  // second "approved" claim into the chain for an approval that did not happen.
  if (changed) {
    await recordPrivilegedAudit(
      principal,
      "protocol.version_approved",
      { versionId: id, version: row.version, via: "director-approval" },
      // Keyed by version id so it never collides with the workflow's own
      // `protocol.version_approved.v<n>` entries (which are keyed by case run + version).
      `protocol.version_approved.direct.${id}`,
    );
  }
  revalidatePath("/protocols");
}

const roleSchema = z.string().refine(isRole, "unknown role");
const userIdSchema = z.string().uuid();

/** Grant a role (admin only, PHASE6 §6.1). */
export async function assignRoleAction(userId: unknown, role: unknown): Promise<void> {
  assertMutationAllowed("Managing users");
  const principal = await requireRole("manage_users");
  const uid = userIdSchema.parse(userId);
  const r = roleSchema.parse(role);
  // Only audit a real grant — assignRole is a no-op when the user already holds the role.
  if (await assignRole(uid, r)) {
    await recordPrivilegedAudit(principal, "user.role_granted", { targetUserId: uid, role: r }, `user.role_granted.${uid}.${r}`);
  }
  revalidatePath("/admin/users");
}

/** Revoke a role (admin only). */
export async function revokeRoleAction(userId: unknown, role: unknown): Promise<void> {
  assertMutationAllowed("Managing users");
  const principal = await requireRole("manage_users");
  const uid = userIdSchema.parse(userId);
  const r = roleSchema.parse(role);
  // Only audit a real revoke — revokeRole is a no-op when the user never held the role.
  if (await revokeRole(uid, r)) {
    await recordPrivilegedAudit(principal, "user.role_revoked", { targetUserId: uid, role: r }, `user.role_revoked.${uid}.${r}`);
  }
  revalidatePath("/admin/users");
}

/** Soft-disable / re-enable a user account (admin only). */
export async function setUserDisabledAction(userId: unknown, disabled: unknown): Promise<void> {
  assertMutationAllowed("Managing users");
  const principal = await requireRole("manage_users");
  const uid = userIdSchema.parse(userId);
  const flag = z.boolean().parse(disabled);
  // Only audit a real state flip — setUserDisabled is a no-op when the account is already in the
  // requested state. eventKey matches the action label ("user.disabled"/"user.enabled").
  if (await setUserDisabled(uid, flag)) {
    const action = flag ? "user.disabled" : "user.enabled";
    await recordPrivilegedAudit(principal, action, { targetUserId: uid }, `${action}.${uid}`);
  }
  revalidatePath("/admin/users");
}

/**
 * The one mutation demo mode allows: start a real case for one of the catalogue drugs
 * (PROJECT_PLAN §11). Rate limiting and the drug allow-list live in `@stopgap/demo`, because
 * they must hold for every caller and not just for whoever came through this button.
 */
export async function startDemoShortage(key: unknown): Promise<DemoRunResult> {
  // A server action is a public endpoint whether or not a button renders it, and outside the
  // demo there is no reason for anyone to open cases for three fixed drugs.
  if (!isDemoMode()) {
    return { ok: false, reason: "unknown-drug", message: "demo scenarios are not enabled" };
  }
  const prepared = await prepareDemoRun(z.string().min(1).max(120).parse(key));
  if (!prepared.ok) return prepared;
  const started = await withTemporalClient((client) => startCase(client, prepared.record));
  revalidatePath("/");
  return { ok: true, ...started };
}
