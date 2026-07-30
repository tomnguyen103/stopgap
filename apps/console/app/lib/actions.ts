"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createHash } from "node:crypto";

import { isRole } from "@stopgap/core";
import { CATALOG_KINDS, planImport } from "@stopgap/catalog";
import { describeRowError } from "./catalog-list";
import { MAX_UPLOAD_BYTES } from "./upload-limit";
import {
  appendAudit,
  importCatalog,
  createAlertRule,
  updateAlertRule,
  approveProtocolVersion,
  supersedeProtocolVersion,
  assignRole,
  getCaseByKey,
  getCaseByWorkflowId,
  getOrganization,
  isApiScope,
  issueApiKey,
  revokeApiKey,
  revokeRole,
  setUserDisabled,
  withOrgDb,
} from "@stopgap/db";
import {
  assertMutationAllowed,
  isDemoMode,
  prepareDemoRun,
  type DemoRunResult,
} from "@stopgap/demo";
import {
  acknowledgeCase as signalAcknowledge,
  resolveException,
  startCase,
  submitReview,
  withTemporalClient,
} from "@stopgap/workflows";
import { requireRole } from "./auth-guards";
import {
  ACTIVE_ORG_COOKIE,
  ACTIVE_ORG_COOKIE_MAX_AGE_SECONDS,
  resolvePrincipal,
} from "./principal";

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
 *
 * A THIRD thing comes from the session and never from the caller (PHASE6 §6.5): the ORG.
 * `principal.orgId` is resolved server-side in `resolvePrincipal`, every DB read and write below
 * runs inside `withOrgDb(principal.orgId, ...)`, and every audit entry records it. No action here
 * accepts an org as an argument, which is the property that makes cross-tenant access impossible
 * to request rather than merely forbidden: there is no parameter to put another hospital's id in.
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

/**
 * The case row behind the workflow id a page is showing, scoped to the caller's org.
 *
 * Returns the ROW, not just the key, because the signal helpers now address a workflow by the id
 * the row CARRIES rather than by one recomputed from the key (PHASE6 §6.5): a case opened before
 * the org-qualified format answers only to `case-<key>`, so recomputing would silently signal a
 * workflow that does not exist. The org predicate is what makes a guessed workflow id from another
 * tenant a plain "no case", with RLS behind it as the backstop.
 */
async function caseForWorkflow(orgId: string, workflowId: string) {
  const row = await withOrgDb(orgId, (db) => getCaseByWorkflowId(db, orgId, workflowId));
  if (!row) throw new Error(`no case for workflow ${workflowId}`);
  return row;
}

export async function reviewCase(workflowId: string, decision: unknown): Promise<void> {
  // A public demo must not let a visitor approve clinical guidance; and only a pharmacist+
  // may review at all. Both gates fail the anonymous demo viewer — the same locked-down result.
  assertMutationAllowed("Approving or rejecting a case");
  const principal = await requireRole("review_case");
  const parsed = reviewDecisionSchema.parse(decision);
  const row = await caseForWorkflow(principal.orgId, workflowIdSchema.parse(workflowId));
  await withTemporalClient((client) =>
    submitReview(client, row.workflowId, parsed, principal.label, principal.userId ?? undefined),
  );
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/");
}

export async function resolveExceptionCase(workflowId: string, resolution: unknown): Promise<void> {
  assertMutationAllowed("Resolving an exception");
  const principal = await requireRole("resolve_exception");
  const parsed = resolutionSchema.parse(resolution);
  const row = await caseForWorkflow(principal.orgId, workflowIdSchema.parse(workflowId));
  await withTemporalClient((client) =>
    resolveException(client, row.workflowId, {
      ...parsed,
      resolvedBy: principal.label,
      resolvedByUserId: principal.userId ?? undefined,
    }),
  );
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/protocols");
}

/**
 * Acknowledge an escalating case (PHASE6 §6.3). Gated to pharmacist+ (`review_case`), so the
 * anonymous demo viewer — and any signed-in viewer — fails server-side, not just in the UI. The
 * ack identity is the authenticated principal's real `users.id`, threaded through the workflow
 * signal into the `acknowledgments` row and the audit chain; a viewer with no `users.id` could not
 * ack even past the role gate. The tier is not a parameter: the workflow records the tier its own
 * ladder has reached, so a caller cannot claim an ack for a tier that never fired.
 */
export async function acknowledgeCase(workflowId: unknown): Promise<void> {
  assertMutationAllowed("Acknowledging a case");
  const principal = await requireRole("review_case");
  // A signed-in pharmacist always has a `users.id`; the guard already rejected the anonymous
  // viewer, so this only guards the (impossible-past-the-gate) authenticated-without-id case.
  if (!principal.userId) throw new Error("acknowledge requires an authenticated user id");
  const row = await caseForWorkflow(principal.orgId, workflowIdSchema.parse(workflowId));
  await withTemporalClient((client) =>
    signalAcknowledge(client, row.workflowId, {
      userId: principal.userId!,
      label: principal.label,
    }),
  );
  revalidatePath(`/cases/${encodeURIComponent(String(workflowId))}`);
}

/**
 * Record a privileged (non-case) action in the audit chain with the authenticated principal.
 * Shared by the protocol-approval and admin user actions, which otherwise repeat the same
 * actor/actorUserId/identitySource shape. These entries have no `caseId`, so `appendAudit` does
 * not dedupe on `eventKey` — the key is a stable, descriptive label (never a timestamp), and the
 * NULL `caseId` keeps rows distinct in the unique index so repeated grants/toggles each append.
 */
async function recordPrivilegedAudit(
  principal: { label: string; userId: string | null; orgId: string },
  action: string,
  detail: Record<string, unknown>,
  eventKey: string,
  /**
   * An OPEN tenant transaction to append inside, when the caller has one.
   *
   * Without it this opens its own, and the write it records has already committed — so an audit
   * failure leaves the action done and unrecorded, which for withdrawing live clinical guidance is
   * the one combination that must not happen. Passing the transaction makes the entry and the
   * change succeed or fail together.
   */
  tx?: Parameters<Parameters<typeof withOrgDb>[1]>[0],
): Promise<void> {
  // The org the caller is ACTING IN, which for an admin using the active-org switch is the tenant
  // they switched to, not their home org. That is the point of recording it: the chain has to say
  // which hospital an action happened in, and for a deployment admin those two can differ.
  const append = (db: Parameters<Parameters<typeof withOrgDb>[1]>[0]) =>
    appendAudit(db, {
      orgId: principal.orgId,
      actor: principal.label,
      actorUserId: principal.userId ?? undefined,
      action,
      detail: { ...detail, identitySource: "authenticated-session" },
      eventKey,
    });
  if (tx) {
    await append(tx);
    return;
  }
  await withOrgDb(principal.orgId, append);
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
  // ONE TRANSACTION over the change and its audit entry. Opened separately, the approval commits
  // first and an audit failure leaves it recorded nowhere — the chain's job is to have no holes,
  // and a hole exactly where a director approved clinical guidance is the worst one available.
  await withOrgDb(principal.orgId, async (db) => {
    const { row, changed } = await approveProtocolVersion(
      principal.orgId,
      id,
      principal.label,
      principal.userId ?? undefined,
      db,
    );
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
        db,
      );
    }
  });
  revalidatePath("/protocols");
}

/**
 * Alert-rule input, validated at the boundary (ticket 14).
 *
 * `cooldownMinutes` is bounded here AND refused by the database helper: this schema is what turns
 * a form post into a typed value, and `createAlertRule` is what refuses a zero cooldown for the
 * reason stated on it. Two checks, because a form is not the only caller.
 */
const alertRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  minSeverity: z.enum(["low", "moderate", "high", "critical"]),
  cooldownMinutes: z.coerce.number().int().min(1).max(10_080),
  channels: z.array(z.enum(["email", "chat"])).min(1),
  riskDomain: z.enum(["shortage", "recall"]).nullish(),
  entityContains: z.string().trim().max(200).nullish(),
  chatWebhookUrl: z.string().url().max(2_000).nullish(),
  enabled: z.boolean().optional(),
});

/** Create an alert rule. Director-gated: a rule decides who gets paged and how often. */
/**
 * WITHDRAW the approved version of a protocol, putting nothing in its place (ticket 14).
 *
 * The other half of "approved or superseded", and a different act from approving. Approving
 * supersedes the previous version on the way past — the protocol has live guidance throughout.
 * This leaves it with NONE, deliberately: the guidance we published is wrong or overtaken, and no
 * guidance is safer than misleading guidance while the replacement is written. Stale advice
 * outliving its shortage is the failure this exists to prevent.
 *
 * Same gate as approval (`approve_protocol_version` → `pharmacy_director`): withdrawing live
 * clinical guidance is at least as consequential as publishing it, so it is not a lesser
 * permission.
 */
export async function supersedeProtocolVersionAction(versionId: unknown): Promise<void> {
  assertMutationAllowed("Withdrawing a protocol version");
  const principal = await requireRole("approve_protocol_version");
  const id = z.string().uuid().parse(versionId);
  // ONE TRANSACTION over the withdrawal and its audit entry, for the reason above and more sharply
  // here: this takes live guidance off the floor, and a withdrawal nobody can account for is worse
  // than one that failed outright.
  await withOrgDb(principal.orgId, async (db) => {
    const { row, changed } = await supersedeProtocolVersion(
      principal.orgId,
      id,
      principal.label,
      principal.userId ?? undefined,
      db,
    );
    // Nothing to record when it was already withdrawn: a second entry would claim a withdrawal that
    // did not happen, the same reason approval skips its own no-op.
    if (changed) {
      await recordPrivilegedAudit(
        principal,
        "protocol.version_withdrawn",
        { versionId: id, version: row.version },
        `protocol.version_withdrawn.${id}`,
        db,
      );
    }
  });
  revalidatePath("/protocols");
  revalidatePath("/approvals");
  revalidatePath("/oversight");
}

export async function createAlertRuleAction(input: unknown): Promise<void> {
  assertMutationAllowed("Creating an alert rule");
  const principal = await requireRole("manage_alert_rules");
  const parsed = alertRuleSchema.parse(input);
  const row = await withOrgDb(principal.orgId, (db) => createAlertRule(db, principal.orgId, parsed));
  await recordPrivilegedAudit(
    principal,
    "alert_rule.created",
    // The rule's SHAPE, not a webhook URL: a chat webhook is a credential, and the audit chain is
    // read by more people than the settings page that set it.
    {
      ruleId: row.id,
      name: row.name,
      minSeverity: row.minSeverity,
      cooldownMinutes: row.cooldownMinutes,
    },
    `alert_rule.created.${row.id}`,
  );
  revalidatePath("/alerts");
}

/** Tune an existing rule. Same gate, same reasoning — a cooldown change is a paging change. */
export async function updateAlertRuleAction(ruleId: unknown, input: unknown): Promise<void> {
  assertMutationAllowed("Updating an alert rule");
  const principal = await requireRole("manage_alert_rules");
  const id = z.string().uuid().parse(ruleId);
  // The FULL shape, not a patch: `updateAlertRule` replaces the row's settable columns, so a
  // partial parse here would quietly reset every field the form did not send.
  const parsed = alertRuleSchema.parse(input);
  const row = await withOrgDb(principal.orgId, (db) =>
    updateAlertRule(db, principal.orgId, id, parsed),
  );
  // A rule belonging to another tenant is simply not found — the update matched nothing, and the
  // audit chain must not record a change that did not happen.
  if (!row) throw new Error("alert rule not found");
  await recordPrivilegedAudit(
    principal,
    "alert_rule.updated",
    {
      ruleId: id,
      enabled: row.enabled,
      minSeverity: row.minSeverity,
      cooldownMinutes: row.cooldownMinutes,
    },
    // Keyed on the rule AND the moment: a rule tuned twice is two entries, not one restated.
    `alert_rule.updated.${id}.${String(row.updatedAt.getTime())}`,
  );
  revalidatePath("/alerts");
}

/**
 * Import a catalog file (ticket 17).
 *
 * Gated on `manage_catalog`, its own capability at admin rank: a catalog upload rewrites the facts
 * every score is computed from, and borrowing `manage_users` would have made the role matrix say
 * something it does not mean.
 *
 * The plan is built and REFUSED as a whole when any row fails: a partially-applied catalog is a
 * facility that believes it stocks things it does not. Every failing row comes back with its line
 * so the file can be corrected, rather than one error at a time.
 */
export async function importCatalogAction(
  kind: unknown,
  csv: unknown,
): Promise<{ ok: true; kind: string; rowsApplied: number } | { ok: false; errors: string[] }> {
  assertMutationAllowed("Importing a catalog file");
  const principal = await requireRole("manage_catalog");
  const parsedKind = z.enum(CATALOG_KINDS).parse(kind);
  // Bounded before it is parsed: an unbounded upload is memory the request did not ask permission
  // for, and a catalog file that large is a mistake rather than a facility.
  //
  // BYTES, not characters. `z.string().max()` counts UTF-16 code units, and the panel that checks
  // this first measures `File.size`, which is bytes — so the two limits disagreed on any file
  // carrying non-ASCII, which a product list with accented supplier names routinely does. The
  // server's limit is the one that binds, so it is the one that has to mean what it says.
  const text = z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_UPLOAD_BYTES,
      `catalog upload exceeds ${String(MAX_UPLOAD_BYTES)} bytes`,
    )
    .parse(csv);
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 32);
  const plan = planImport(parsedKind, text);
  // The SAME formatter the page uses. Two copies had already drifted on their quote characters,
  // which is how a message a person is meant to act on becomes two messages.
  if (!plan.ok) {
    // A REFUSAL IS STILL AN ATTEMPT. Auditing only successful imports leaves an administrator able
    // to probe the catalog parser repeatedly with nothing in the chain to show for it, and leaves
    // the one question an incident asks — who tried to load what, and when — unanswerable. The
    // shape only: how many rows failed and the digest of the file, never its contents.
    await recordPrivilegedAudit(
      principal,
      "catalog.import_refused",
      { kind: parsedKind, errors: plan.errors.length, contentSha256: digest },
      `catalog.import_refused.${parsedKind}.${digest}`,
    );
    return { ok: false, errors: plan.errors.map(describeRowError) };
  }
  const result = await importCatalog(principal.orgId, plan);
  await recordPrivilegedAudit(
    principal,
    "catalog.imported",
    // The SHAPE of the import, never its contents: the audit chain records that a catalog was
    // replaced and how much of it, not the facility's product list.
    { kind: result.kind, rowsApplied: result.rowsApplied, contentSha256: digest },
    // Keyed on WHAT was imported, not on when. A clock-keyed event key makes a double-click two
    // entries for one import; the digest also lets the chain answer "which file was this".
    `catalog.imported.${result.kind}.${digest}`,
  );
  revalidatePath("/admin/catalog");
  revalidatePath("/admin");
  return { ok: true, kind: result.kind, rowsApplied: result.rowsApplied };
}

const roleSchema = z.string().refine(isRole, "unknown role");
const userIdSchema = z.string().uuid();

/**
 * Grant a role (admin only, PHASE6 §6.1), CONSTRAINED TO THE ADMIN'S ACTIVE ORG (§6.5).
 *
 * A uuid is the only thing these two actions receive, and validating that it IS a uuid says nothing
 * about WHOSE it is. Before the org scope below, an admin acting in org A could grant or revoke any
 * role on any user in org B by knowing their id — bypassing the audited active-org switch entirely,
 * and filing the audit entry in the acting admin's org, so the target hospital's own chain never
 * recorded that its user's privileges changed. `setUserDisabledAction` on the next page down was
 * already doing this correctly; these two were the outliers.
 *
 * The org predicate lives inside `assignRole`/`revokeRole` (on `users`, the RLS-protected table),
 * and a foreign id makes them THROW rather than return "no change" — an attempt to reach into
 * another tenant must not be indistinguishable from a re-grant that was already in place. Since the
 * target is now necessarily a member of `principal.orgId`, the audit entry `recordPrivilegedAudit`
 * writes into that org IS the target user's org: the two can no longer diverge.
 */
export async function assignRoleAction(userId: unknown, role: unknown): Promise<void> {
  assertMutationAllowed("Managing users");
  const principal = await requireRole("manage_users");
  const uid = userIdSchema.parse(userId);
  const r = roleSchema.parse(role);
  // Only audit a real grant — assignRole is a no-op when the user already holds the role.
  if (await withOrgDb(principal.orgId, (db) => assignRole(db, principal.orgId, uid, r))) {
    await recordPrivilegedAudit(
      principal,
      "user.role_granted",
      { targetUserId: uid, role: r },
      `user.role_granted.${uid}.${r}`,
    );
  }
  revalidatePath("/admin/users");
}

/** Revoke a role (admin only). Org-scoped exactly as `assignRoleAction` above. */
export async function revokeRoleAction(userId: unknown, role: unknown): Promise<void> {
  assertMutationAllowed("Managing users");
  const principal = await requireRole("manage_users");
  const uid = userIdSchema.parse(userId);
  const r = roleSchema.parse(role);
  // Only audit a real revoke — revokeRole is a no-op when the user never held the role.
  if (await withOrgDb(principal.orgId, (db) => revokeRole(db, principal.orgId, uid, r))) {
    await recordPrivilegedAudit(
      principal,
      "user.role_revoked",
      { targetUserId: uid, role: r },
      `user.role_revoked.${uid}.${r}`,
    );
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
  if (await withOrgDb(principal.orgId, (db) => setUserDisabled(principal.orgId, uid, flag, db))) {
    const action = flag ? "user.disabled" : "user.enabled";
    await recordPrivilegedAudit(principal, action, { targetUserId: uid }, `${action}.${uid}`);
  }
  revalidatePath("/admin/users");
}

const issueApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string().refine(isApiScope, "unknown scope")).min(1),
  rateLimitPerHour: z.number().int().min(1).max(100_000),
});

/**
 * Issue an API key (admin only, PHASE6 §6.7).
 *
 * Returns the PLAINTEXT — the only time it ever exists outside the caller's client. The page shows
 * it once with a "you will not see this again" note, because the database holds only its SHA-256
 * hash and there is no recovery path, only revoke-and-reissue. That is the intended trade: a DB
 * read cannot mint a usable credential.
 *
 * The plaintext is deliberately absent from the audit detail and from every log line here. An
 * audit chain that recorded the secret would turn the tamper-evident record — the thing operators
 * export and hand to auditors — into a credential store. What IS recorded is everything needed to
 * revoke: the key's id, name, scopes, and limit.
 */
export async function issueApiKeyAction(
  input: unknown,
): Promise<{ id: string; name: string; keyPrefix: string; plaintext: string }> {
  assertMutationAllowed("Issuing an API key");
  const principal = await requireRole("manage_api_keys");
  const parsed = issueApiKeySchema.parse(input);
  // The key is issued INTO the admin's ACTIVE org and can never act outside it — see
  // `apps/console/app/lib/api-auth.ts`, where every `/api/v1` request scopes to `key.orgId`.
  const { row, plaintext } = await withOrgDb(principal.orgId, (db) =>
    issueApiKey(
      {
        orgId: principal.orgId,
        name: parsed.name,
        scopes: parsed.scopes,
        rateLimitPerHour: parsed.rateLimitPerHour,
        createdByUserId: principal.userId,
      },
      db,
    ),
  );
  // COMPENSATE IF THE AUDIT APPEND FAILS. The key row is committed by the time we get here, and the
  // plaintext is about to be thrown away with the request — so a failed audit would leave a LIVE
  // credential that nobody holds and no chain entry explains: an orphan the admin page shows but
  // cannot account for. Revoking it makes the failure clean, because a revoked key authenticates
  // nothing. This is a compensating action rather than one transaction on purpose: `appendAudit`
  // takes its own advisory lock to serialize the hash chain, and nesting that inside the issue
  // transaction would let a slow chain append hold an unrelated write open.
  try {
    await recordPrivilegedAudit(
      principal,
      "api_key.issued",
      {
        apiKeyId: row.id,
        name: row.name,
        keyPrefix: row.keyPrefix,
        scopes: parsed.scopes,
        rateLimitPerHour: row.rateLimitPerHour,
      },
      `api_key.issued.${row.id}`,
    );
  } catch (err) {
    // Best-effort: if this also fails the key is still unusable to anyone but this request, which
    // is ending without returning the plaintext. Rethrow the ORIGINAL failure either way.
    await withOrgDb(principal.orgId, (db) => revokeApiKey(principal.orgId, row.id, db)).catch(
      () => undefined,
    );
    throw err;
  }
  revalidatePath("/admin/api-keys");
  return { id: row.id, name: row.name, keyPrefix: row.keyPrefix, plaintext };
}

/** Revoke an API key (admin only). Soft — the row stays so audit entries naming it still resolve. */
export async function revokeApiKeyAction(id: unknown): Promise<void> {
  assertMutationAllowed("Revoking an API key");
  const principal = await requireRole("manage_api_keys");
  const keyId = z.string().uuid().parse(id);
  // Only audit a real revocation — revokeApiKey is a no-op on an already-revoked key.
  //
  // Revoke first, audit second, and deliberately NO compensation if the audit throws: unlike
  // issuance, the uncompensated state here is the SAFE one. A revoked key with no chain entry is a
  // credential that can no longer act; undoing the revocation to keep the pair consistent would
  // re-arm a key an admin has already decided to kill. The action still throws, so the operator
  // sees the failure and can re-run it — the second run is a no-op that appends nothing, which is
  // why the audit gap is worth recording here rather than papering over.
  if (await withOrgDb(principal.orgId, (db) => revokeApiKey(principal.orgId, keyId, db))) {
    await recordPrivilegedAudit(
      principal,
      "api_key.revoked",
      { apiKeyId: keyId },
      `api_key.revoked.${keyId}`,
    );
  }
  revalidatePath("/admin/api-keys");
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
  // The demo maps to the seed tenant, and `resolvePrincipal` says so for the anonymous viewer —
  // so the run is opened in the org the visitor is already looking at rather than in an org named
  // separately here, which could drift from it.
  const principal = await resolvePrincipal();
  const prepared = await prepareDemoRun(principal.orgId, z.string().min(1).max(120).parse(key));
  if (!prepared.ok) return prepared;
  const existing = await withOrgDb(principal.orgId, (db) =>
    getCaseByKey(db, principal.orgId, prepared.record.key),
  );
  const started = await withTemporalClient((client) =>
    startCase(
      client,
      principal.orgId,
      prepared.record,
      [prepared.record.source],
      existing?.workflowId,
    ),
  );
  revalidatePath("/");
  return { ok: true, ...started };
}

const orgIdSchema = z.string().uuid();

/**
 * Switch the ADMIN's active organization (PHASE6 §6.5).
 *
 * Three server-side gates, in this order, and none of them is in the UI:
 *
 *  1. `requireRole("manage_users")` — admin-only. The switcher control is hidden from everyone
 *     else, but a server action is a public endpoint whether or not a button renders it, so the
 *     hiding is a convenience and THIS is the enforcement. `manage_users` is the existing
 *     admin-minimum action rather than a new one, so the matrix keeps one definition of "admin".
 *  2. the org must exist. A cookie naming a nonexistent tenant is fail-closed at the database but
 *     presents as an inexplicably empty console; refusing it here says what actually went wrong.
 *  3. the audit append happens BEFORE the cookie is set. An admin entering another hospital's data
 *     is the event worth recording, and recording it first means a failure to write the chain
 *     entry prevents the switch rather than leaving an unrecorded one — the switch and its record
 *     cannot come apart in the direction that loses the record.
 *
 * The entry is written in the org being ENTERED, so it lands in that tenant's chain: "an admin
 * from outside acted here" is information that hospital's own audit export must contain.
 *
 * The cookie is `httpOnly` — nothing client-side reads it, `resolvePrincipal` does — and
 * `sameSite: lax`, so a cross-site POST cannot silently re-point an admin's session at another
 * tenant before they act.
 */
export async function setActiveOrgAction(orgId: unknown): Promise<void> {
  assertMutationAllowed("Switching the active organization");
  const principal = await requireRole("manage_users");
  const target = orgIdSchema.parse(orgId);
  const org = await getOrganization(target);
  if (!org) throw new Error(`no such organization: ${target}`);

  // GATED ON "DID THE ACTIVE ORG ACTUALLY CHANGE", like every other privileged action in this file
  // gates its audit on the underlying op's "did state change" return.
  //
  // The eventKey below CANNOT do this job, and the comment that claimed it could was wrong:
  // `appendAudit` only runs its eventKey idempotency lookup when `entry.caseId` is truthy, and
  // `recordPrivilegedAudit` never sets `caseId`. So the key is written to the row and never
  // consulted, and before this check every click on an already-active org appended another
  // "an admin entered this tenant" entry for an entry that did not happen. `principal.orgId` is the
  // org this request is ALREADY acting in (`resolveActiveOrg` has run), so comparing against it is
  // the state question, not a guess about the cookie.
  if (principal.orgId !== org.id) {
    await recordPrivilegedAudit(
      { ...principal, orgId: org.id },
      "org.active_switched",
      { fromOrgId: principal.orgId, toOrgId: org.id, toOrgSlug: org.slug },
      // Still keyed by (admin, target org): it is the row's stable identity for anyone reading the
      // chain, and a different admin or a different tenant records its own entry.
      `org.active_switched.${principal.userId ?? "unknown"}.${org.id}`,
    );
  }

  (await cookies()).set(ACTIVE_ORG_COOKIE, org.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // THE ELEVATED STATE EXPIRES ON ITS OWN (PHASE6 §6.5). Without a lifetime this cookie is a
    // session cookie that survives every navigation and, in a browser that restores tabs, days of
    // them: an admin who switched into another hospital last Tuesday is still acting inside it
    // today, and the next protocol they approve lands in the wrong facility's chain. Nothing else
    // in the system would notice — the switch is legitimate, the audit entry was written a week
    // ago, and the console (before `ActiveOrgBadge`) said nothing. A short window makes "acting as
    // another tenant" something you do deliberately and re-affirm, rather than a mode you forget
    // you are in. One hour: long enough for a real cross-tenant task, short enough that it cannot
    // outlive the reason for it. Re-switching is one click; the cookie is re-set (which is what
    // refreshes the hour), and the audit entry is skipped because the active org did not change.
    maxAge: ACTIVE_ORG_COOKIE_MAX_AGE_SECONDS,
  });
  // Everything on the page is org-scoped, so nothing that was rendered before the switch is still
  // correct after it.
  revalidatePath("/", "layout");
}
