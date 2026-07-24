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

const resolvePrincipal = vi.fn<() => Promise<Principal>>();
vi.mock("./principal", () => ({ resolvePrincipal: () => resolvePrincipal() }));

// DB side effects — spies so we can assert they never fire on an unauthorized call.
const approveProtocolVersion = vi.fn(async (..._a: unknown[]) => ({ version: 3 }));
const appendAudit = vi.fn(async (..._a: unknown[]) => ({ hash: "h" }));
vi.mock("@stopgap/db", () => ({
  appendAudit: (...a: unknown[]) => appendAudit(...a),
  approveProtocolVersion: (...a: unknown[]) => approveProtocolVersion(...a),
  assignRole: vi.fn(),
  revokeRole: vi.fn(),
  setUserDisabled: vi.fn(),
  getCaseByWorkflowId: vi.fn(),
  getDb: () => ({}),
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

const { approveProtocolVersionAction } = await import("./actions");
const { AuthorizationError } = await import("./authz");

function principal(roles: Principal["roles"]): Principal {
  return {
    userId: roles.length > 0 ? "22222222-2222-2222-2222-222222222222" : null,
    label: "dana@hospital.test",
    roles,
    authenticated: roles.length > 0,
  };
}

const VERSION_ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  resolvePrincipal.mockReset();
  approveProtocolVersion.mockClear();
  appendAudit.mockClear();
  withTemporalClient.mockClear();
});

describe("approveProtocolVersionAction (server-enforced authorization)", () => {
  it("REJECTS a pharmacist session with AuthorizationError and runs NO side effect", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacist"]));
    await expect(approveProtocolVersionAction(VERSION_ID)).rejects.toBeInstanceOf(AuthorizationError);
    // The privilege check fires before the DB write / audit append / any workflow call.
    expect(approveProtocolVersion).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
    expect(withTemporalClient).not.toHaveBeenCalled();
  });

  it("lets a pharmacy_director through, performing the approval and the audit append", async () => {
    resolvePrincipal.mockResolvedValue(principal(["pharmacy_director"]));
    await approveProtocolVersionAction(VERSION_ID);
    expect(approveProtocolVersion).toHaveBeenCalledTimes(1);
    expect(approveProtocolVersion).toHaveBeenCalledWith(
      VERSION_ID,
      "dana@hospital.test",
      "22222222-2222-2222-2222-222222222222",
    );
    expect(appendAudit).toHaveBeenCalledTimes(1);
  });
});
