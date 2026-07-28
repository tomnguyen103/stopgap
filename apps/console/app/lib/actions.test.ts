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

const { approveProtocolVersionAction, assignRoleAction, revokeRoleAction } =
  await import("./actions");
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
