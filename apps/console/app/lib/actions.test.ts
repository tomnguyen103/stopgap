import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "./principal";

/**
 * Action-level RBAC integration test (PHASE6 §6.1 acceptance: "an integration test proving a
 * pharmacist session cannot approve a protocol version — server-enforced, not just hidden UI").
 * This drives the REAL `approveProtocolVersionAction` — not `requireRole` in isolation — with a
 * mocked pharmacist principal, and asserts the guard throws BEFORE any DB or workflow side
 * effect runs. Pure: the session, DB, workflow client, and revalidation are all mocked, so no
 * live IdP/Postgres/Temporal is touched.
 */

vi.mock("server-only", () => ({}));

/**
 * The tenant the mocked session acts in (PHASE6 §6.5). A DIFFERENT org from the seed one, on
 * purpose: an assertion that the action scoped to the seed org would pass even if the action had
 * kept a hardcoded default, so the fixture uses an org no default could accidentally be.
 */
const PRINCIPAL_ORG_ID = "cccccccc-0000-0000-0000-0000000000cc";

const resolvePrincipal = vi.fn<() => Promise<Principal>>();
vi.mock("./principal", () => ({
  resolvePrincipal: () => resolvePrincipal(),
  ACTIVE_ORG_COOKIE: "stopgap_active_org",
  ACTIVE_ORG_COOKIE_MAX_AGE_SECONDS: 3600,
}));

/** A user who really is in the acting admin's org, and one who is in some OTHER hospital. */
const MEMBER_USER_ID = "44444444-4444-4444-4444-444444444444";
const FOREIGN_USER_ID = "55555555-5555-5555-5555-555555555555";

// DB side effects — spies so we can assert they never fire on an unauthorized call.
const approveProtocolVersion = vi.fn(async (..._a: unknown[]) => ({
  row: { version: 3 },
  changed: true,
}));
const appendAudit = vi.fn(async (..._a: unknown[]) => ({ hash: "h" }));
/** Orgs `withOrgDb` was opened for, in order — the cross-tenant assertions read this. */
const scopedOrgIds: string[] = [];
/**
 * `assignRole`/`revokeRole` stand in for the real helpers, INCLUDING their org constraint
 * (PHASE6 §6.5): both now take an `orgId` and throw when the target user is not a member of it.
 * Faked rather than stubbed, because the behaviour the action test cares about IS the refusal —
 * a `vi.fn()` returning undefined would make a cross-tenant grant look like a harmless no-op,
 * which is precisely the bug being tested for.
 */
const assignRole = vi.fn(async (_db: unknown, orgId: string, userId: string, _role: string) => {
  if (orgId !== PRINCIPAL_ORG_ID || userId !== MEMBER_USER_ID) {
    throw new Error(`user ${userId} is not a member of organization ${orgId}`);
  }
  return true;
});
const revokeRole = vi.fn(async (_db: unknown, orgId: string, userId: string, _role: string) => {
  if (orgId !== PRINCIPAL_ORG_ID || userId !== MEMBER_USER_ID) {
    throw new Error(`user ${userId} is not a member of organization ${orgId}`);
  }
  return true;
});
const createAlertRule = vi.fn();
const importCatalog = vi.fn();
const updateAlertRule = vi.fn();
vi.mock("@stopgap/db", () => ({
  appendAudit: (...a: unknown[]) => appendAudit(...a),
  approveProtocolVersion: (...a: unknown[]) => approveProtocolVersion(...a),
  assignRole: (...a: [unknown, string, string, string]) => assignRole(...a),
  revokeRole: (...a: [unknown, string, string, string]) => revokeRole(...a),
  setUserDisabled: vi.fn(),
  getCaseByKey: vi.fn(),
  getCaseByWorkflowId: vi.fn(),
  getOrganization: vi.fn(),
  // The production scoping wrapper, stubbed to RECORD the org it was opened for and hand the
  // callback a dummy handle. That is what lets this suite assert tenant scoping without Postgres:
  // if an action ever scoped to something other than the caller's org, `scopedOrgIds` says so.
  withOrgDb: (orgId: string, fn: (db: unknown) => Promise<unknown>) => {
    scopedOrgIds.push(orgId);
    return fn({});
  },
  // PHASE6 §6.7: `actions.ts` now also imports the API-key surface. Stubbed here because this
  // suite is about the RBAC gate, not key issuance — `isApiScope` must be real enough for the
  // module's Zod schema to build at import time.
  isApiScope: (v: unknown) =>
    ["cases:read", "protocols:read", "protocols:write", "shadow:read"].includes(v as string),
  issueApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  // Ticket 14 — the alert-rule surface `actions.ts` now imports.
  createAlertRule: (...a: unknown[]) => createAlertRule(...a),
  // Ticket 17 — the catalog import surface `actions.ts` now imports.
  importCatalog: (...a: unknown[]) => importCatalog(...a),
  updateAlertRule: (...a: unknown[]) => updateAlertRule(...a),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

// Workflow client — spy so we can assert it is NEVER called when authorization fails.
const withTemporalClient = vi.fn();
vi.mock("@stopgap/workflows", () => ({
  withTemporalClient: (...a: unknown[]) => withTemporalClient(...a),
  submitReview: vi.fn(),
  resolveException: vi.fn(),
  startCase: vi.fn(),
}));

// Demo gate is not under test here — let mutations through so RBAC is the only gate exercised.
vi.mock("@stopgap/demo", () => ({
  assertMutationAllowed: vi.fn(),
  isDemoMode: () => false,
  prepareDemoRun: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const {
  approveProtocolVersionAction,
  assignRoleAction,
  revokeRoleAction,
  createAlertRuleAction,
  updateAlertRuleAction,
  importCatalogAction,
} = await import("./actions");
const { AuthorizationError } = await import("./authz");

function principal(roles: Principal["roles"]): Principal {
  return {
    userId: roles.length > 0 ? "22222222-2222-2222-2222-222222222222" : null,
    label: "dana@hospital.test",
    roles,
    authenticated: roles.length > 0,
    orgId: PRINCIPAL_ORG_ID,
  };
}

const VERSION_ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  resolvePrincipal.mockReset();
  approveProtocolVersion.mockClear();
  appendAudit.mockClear();
  withTemporalClient.mockClear();
  assignRole.mockClear();
  revokeRole.mockClear();
  scopedOrgIds.length = 0;
});

/**
 * CROSS-TENANT ROLE GRANTS (PHASE6 §6.5).
 *
 * `assignRoleAction`/`revokeRoleAction` receive a bare uuid, and validating that it IS a uuid says
 * nothing about whose it is. Until these helpers took an org, an admin acting in org A could grant
 * or revoke any role on any user in org B just by knowing their id — skipping the audited
 * active-org switch entirely, and filing the audit entry in the ACTING admin's org so the target
 * hospital's chain never recorded that its user's privileges changed.
 */
describe("role management is confined to the admin's active org", () => {
  it("REFUSES a grant against a user id belonging to another organization", async () => {
    resolvePrincipal.mockResolvedValue(principal(["admin"]));
    await expect(assignRoleAction(FOREIGN_USER_ID, "pharmacist")).rejects.toThrow(/not a member/);
    // Refused, not silently skipped: nothing lands in any chain. An audit entry here would be the
    // second half of the bug — the grant filed against the wrong tenant's history.
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it("REFUSES a revoke against a user id belonging to another organization", async () => {
    resolvePrincipal.mockResolvedValue(principal(["admin"]));
    await expect(revokeRoleAction(FOREIGN_USER_ID, "pharmacist")).rejects.toThrow(/not a member/);
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it("grants inside the admin's own org, scoped and audited to that org", async () => {
    resolvePrincipal.mockResolvedValue(principal(["admin"]));
    await assignRoleAction(MEMBER_USER_ID, "pharmacist");
    // The org travels WITH the call rather than being left to an ambient connection.
    expect(assignRole).toHaveBeenCalledWith({}, PRINCIPAL_ORG_ID, MEMBER_USER_ID, "pharmacist");
    expect(new Set(scopedOrgIds)).toEqual(new Set([PRINCIPAL_ORG_ID]));
    // Since the target is necessarily a member of the acting org, the entry lands in the TARGET
    // user's org by construction — the two can no longer diverge.
    expect(appendAudit).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: PRINCIPAL_ORG_ID, action: "user.role_granted" }),
    );
  });

  it("REJECTS a pharmacist attempting a grant at all (RBAC still first)", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(assignRoleAction(MEMBER_USER_ID, "pharmacist")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(assignRole).not.toHaveBeenCalled();
  });
});

describe("approveProtocolVersionAction (server-enforced authorization)", () => {
  it("REJECTS a pharmacist session with AuthorizationError and runs NO side effect", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(approveProtocolVersionAction(VERSION_ID)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    // The privilege check fires before the DB write / audit append / any workflow call.
    expect(approveProtocolVersion).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
    expect(withTemporalClient).not.toHaveBeenCalled();
  });

  it("lets a pharmacy_director through, performing the approval and the audit append", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    approveProtocolVersion.mockResolvedValueOnce({ row: { version: 3 }, changed: true });
    await approveProtocolVersionAction(VERSION_ID);
    expect(approveProtocolVersion).toHaveBeenCalledTimes(1);
    expect(approveProtocolVersion).toHaveBeenCalledWith(
      // The SESSION's org (PHASE6 §6.5), resolved server-side — the action takes no org argument,
      // so there is nowhere for a caller to put another tenant's id.
      PRINCIPAL_ORG_ID,
      VERSION_ID,
      "dana@hospital.test",
      "22222222-2222-2222-2222-222222222222",
      // The org-scoped handle `withOrgDb` supplied.
      {},
    );
    expect(appendAudit).toHaveBeenCalledTimes(1);
  });

  it("scopes the approval AND its audit entry to the caller's org, never an ambient default", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    approveProtocolVersion.mockResolvedValueOnce({ row: { version: 3 }, changed: true });
    await approveProtocolVersionAction(VERSION_ID);
    // Every DB transaction this action opened named the caller's org — the approval and the
    // privileged-audit append. A hardcoded seed org (the pass-1 shape) would show up here as an
    // id that is not `PRINCIPAL_ORG_ID`, which is the regression this test exists to catch.
    expect(scopedOrgIds.length).toBeGreaterThan(0);
    expect(new Set(scopedOrgIds)).toEqual(new Set([PRINCIPAL_ORG_ID]));
    // And the entry RECORDS the org it happened in, so the chain answers "which hospital".
    expect(appendAudit).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: PRINCIPAL_ORG_ID }),
    );
  });

  it("does NOT audit a no-op approval (version already approved → changed:false)", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    approveProtocolVersion.mockResolvedValueOnce({ row: { version: 3 }, changed: false });
    await approveProtocolVersionAction(VERSION_ID);
    expect(approveProtocolVersion).toHaveBeenCalledTimes(1);
    expect(appendAudit).not.toHaveBeenCalled();
  });
});

describe("alert-rule actions (server-enforced authorization)", () => {
  beforeEach(() => {
    // This suite's outer `beforeEach` clears the shared spies; these two are local to it.
    createAlertRule.mockReset();
    updateAlertRule.mockReset();
  });

  const RULE = {
    name: "Critical shortages",
    minSeverity: "critical" as const,
    cooldownMinutes: 60,
    channels: ["email" as const],
  };

  it("REFUSES a pharmacist, who works cases but does not decide who gets paged", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(createAlertRuleAction(RULE)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(updateAlertRuleAction(VERSION_ID, RULE)).rejects.toBeInstanceOf(AuthorizationError);
    // The gate fires before the write and before the audit append, not after.
    expect(createAlertRule).not.toHaveBeenCalled();
    expect(updateAlertRule).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it("lets a director create a rule, scoped to their own org, and audits the shape", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    createAlertRule.mockResolvedValueOnce({
      id: "11111111-1111-1111-1111-111111111111",
      name: RULE.name,
      minSeverity: RULE.minSeverity,
      cooldownMinutes: RULE.cooldownMinutes,
    });
    await createAlertRuleAction(RULE);
    expect(createAlertRule).toHaveBeenCalledTimes(1);
    expect(scopedOrgIds).toContain(PRINCIPAL_ORG_ID);
    expect(appendAudit).toHaveBeenCalled();
  });

  it("refuses a cooldown of zero rather than clamping it", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    await expect(createAlertRuleAction({ ...RULE, cooldownMinutes: 0 })).rejects.toThrow();
    expect(createAlertRule).not.toHaveBeenCalled();
  });

  it("refuses a rule with no channel — an alert nobody receives is not an alert", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    await expect(createAlertRuleAction({ ...RULE, channels: [] })).rejects.toThrow();
    expect(createAlertRule).not.toHaveBeenCalled();
  });
});

describe("importCatalogAction (server-enforced authorization)", () => {
  const CSV = ["sku,name", "SKU-1,Cefazolin 1g vial", ""].join(String.fromCharCode(10));

  beforeEach(() => {
    importCatalog.mockReset();
  });

  it("REFUSES a pharmacy_director — a catalog rewrites what every score is computed from", () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    return expect(importCatalogAction("items", CSV))
      .rejects.toBeInstanceOf(AuthorizationError)
      .then(() => {
        expect(importCatalog).not.toHaveBeenCalled();
        expect(appendAudit).not.toHaveBeenCalled();
      });
  });

  it("refuses an unauthenticated caller the same way it refuses an under-privileged one", async () => {
    resolvePrincipal.mockResolvedValue(principal([]));
    await expect(importCatalogAction("items", CSV)).rejects.toBeInstanceOf(AuthorizationError);
    expect(importCatalog).not.toHaveBeenCalled();
  });

  it("lets an admin through, scoped to their own org, and audits the shape not the contents", async () => {
    resolvePrincipal.mockResolvedValue(principal(["admin"]));
    importCatalog.mockResolvedValueOnce({ kind: "items", rowsApplied: 1 });
    const result = await importCatalogAction("items", CSV);
    expect(result).toMatchObject({ ok: true, rowsApplied: 1 });
    expect(scopedOrgIds).toContain(PRINCIPAL_ORG_ID);
    const detail = appendAudit.mock.calls.at(-1)?.[1] as { detail: Record<string, unknown> };
    expect(detail.detail).toMatchObject({ kind: "items", rowsApplied: 1 });
    // The file's fingerprint, never its rows: the chain records which catalog was loaded, not the
    // facility's product list.
    expect(JSON.stringify(detail.detail)).not.toContain("Cefazolin");
  });

  it("refuses a kind the importer cannot read, before touching the database", async () => {
    resolvePrincipal.mockResolvedValue(principal(["admin"]));
    await expect(importCatalogAction("not_a_kind", CSV)).rejects.toThrow();
    expect(importCatalog).not.toHaveBeenCalled();
  });
});
