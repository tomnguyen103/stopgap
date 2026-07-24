import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API-key authentication and scope enforcement (PHASE6 §6.7 acceptance: "scope matrix covered by
 * tests"). Drives the REAL `authenticateApiRequest` with the DB layer mocked at the module
 * boundary, so the whole gate — bearer parsing, key lookup, scope check, rate reservation — is
 * exercised without Postgres.
 *
 * The headline cases: a `cases:read` key CANNOT write (403, server-enforced), a revoked or unknown
 * key is indistinguishable from no key at all (401, no oracle), and an exhausted key is throttled
 * (429) rather than served.
 */

vi.mock("server-only", () => ({}));

const findActiveApiKeyByPlaintext = vi.fn();
const reserveApiKeyRequest = vi.fn(async (..._a: unknown[]) => ({ allowed: true, recent: 1 }));
const touchApiKeyUsed = vi.fn(async (..._a: unknown[]) => undefined);
const appendAudit = vi.fn(async (..._a: unknown[]) => ({ hash: "h" }));

vi.mock("@stopgap/db", () => ({
  appendAudit: (...a: unknown[]) => appendAudit(...a),
  getDb: () => ({}),
  findActiveApiKeyByPlaintext: (...a: unknown[]) => findActiveApiKeyByPlaintext(...a),
  reserveApiKeyRequest: (...a: unknown[]) => reserveApiKeyRequest(...a),
  touchApiKeyUsed: (...a: unknown[]) => touchApiKeyUsed(...a),
  isApiScope: (v: unknown) =>
    ["cases:read", "protocols:read", "protocols:write", "shadow:read"].includes(v as string),
}));

// The demo gate is a separate concern; let mutations through so scope is the only gate exercised.
class DemoReadOnlyError extends Error {}
vi.mock("@stopgap/demo", () => ({
  assertMutationAllowed: vi.fn(),
  DemoReadOnlyError,
}));

const { authenticateApiRequest, apiKeyActorLabel } = await import("./api-auth");

const ISSUER_ID = "44444444-4444-4444-4444-444444444444";

function keyRow(scopes: string[], patch: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-5555-5555-555555555555",
    name: "epic-integration",
    keyHash: "deadbeef",
    // A real prefix: the namespace PLUS random characters, which is what `generateApiKey` mints.
    keyPrefix: "sk_live_Qa7xK2",
    scopes,
    rateLimitPerHour: 1000,
    createdByUserId: ISSUER_ID,
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
    ...patch,
  };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://console.test/api/v1/cases", { headers });
}

beforeEach(() => {
  findActiveApiKeyByPlaintext.mockReset();
  reserveApiKeyRequest.mockReset();
  reserveApiKeyRequest.mockResolvedValue({ allowed: true, recent: 1 });
  touchApiKeyUsed.mockClear();
});

describe("authentication", () => {
  it("401s a request with NO Authorization header, and never touches the key store", async () => {
    const result = await authenticateApiRequest(request(), "cases:read");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await result.response.json()).toMatchObject({ error: "unauthorized" });
    expect(findActiveApiKeyByPlaintext).not.toHaveBeenCalled();
  });

  it("401s a malformed Authorization header (not `Bearer <token>`)", async () => {
    const result = await authenticateApiRequest(request({ authorization: "Basic abc" }), "cases:read");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(findActiveApiKeyByPlaintext).not.toHaveBeenCalled();
  });

  it("401s an UNKNOWN key", async () => {
    findActiveApiKeyByPlaintext.mockResolvedValue(undefined);
    const result = await authenticateApiRequest(request({ authorization: "Bearer sk_live_nope" }), "cases:read");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });

  it("401s a REVOKED key with a body identical to the unknown-key case (no oracle)", async () => {
    // `findActiveApiKeyByPlaintext` filters `revokedAt IS NULL` in SQL, so a revoked key comes back
    // as undefined — the same value, the same code path, the same body as a key that never existed.
    findActiveApiKeyByPlaintext.mockResolvedValue(undefined);
    const revoked = await authenticateApiRequest(request({ authorization: "Bearer sk_live_revoked" }), "cases:read");
    const unknown = await authenticateApiRequest(request({ authorization: "Bearer sk_live_unknown" }), "cases:read");
    expect(revoked.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (revoked.ok || unknown.ok) return;
    expect(revoked.response.status).toBe(unknown.response.status);
    expect(await revoked.response.json()).toEqual(await unknown.response.json());
  });
});

describe("scope enforcement", () => {
  it("403s a cases:read-only key on a protocols:write endpoint, naming the required scope", async () => {
    findActiveApiKeyByPlaintext.mockResolvedValue(keyRow(["cases:read"]));
    const result = await authenticateApiRequest(request({ authorization: "Bearer sk_live_ro" }), "protocols:write");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error).toBe("forbidden");
    expect(body.message).toContain("protocols:write");
    // Refused BEFORE any rate budget is spent — a wrong-scope caller must not burn the key's quota.
    expect(reserveApiKeyRequest).not.toHaveBeenCalled();
  });

  it("passes a key that DOES carry the scope, and stamps last-used", async () => {
    const row = keyRow(["cases:read", "protocols:write"]);
    findActiveApiKeyByPlaintext.mockResolvedValue(row);
    const result = await authenticateApiRequest(request({ authorization: "Bearer sk_live_rw" }), "protocols:write");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key).toBe(row);
    expect(touchApiKeyUsed).toHaveBeenCalledWith(row.id);
  });

  it("ignores an unrecognized scope stored on the key rather than honouring it", async () => {
    findActiveApiKeyByPlaintext.mockResolvedValue(keyRow(["*", "everything", "cases:read"]));
    const denied = await authenticateApiRequest(request({ authorization: "Bearer sk_live_x" }), "protocols:write");
    expect(denied.ok).toBe(false);
    const allowed = await authenticateApiRequest(request({ authorization: "Bearer sk_live_x" }), "cases:read");
    expect(allowed.ok).toBe(true);
  });
});

describe("rate limiting", () => {
  it("429s with Retry-After when the reservation is refused", async () => {
    findActiveApiKeyByPlaintext.mockResolvedValue(keyRow(["cases:read"], { rateLimitPerHour: 10 }));
    reserveApiKeyRequest.mockResolvedValue({ allowed: false, recent: 10 });
    const result = await authenticateApiRequest(request({ authorization: "Bearer sk_live_busy" }), "cases:read");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("Retry-After")).toBe("3600");
    const body = await result.response.json();
    expect(body.error).toBe("rate_limited");
    expect(body.message).toContain("10");
  });

  it("reserves against the key's own hourly limit within a one-hour window", async () => {
    findActiveApiKeyByPlaintext.mockResolvedValue(keyRow(["shadow:read"], { rateLimitPerHour: 25 }));
    await authenticateApiRequest(request({ authorization: "Bearer sk_live_ok" }), "shadow:read");
    const [id, since, limit] = reserveApiKeyRequest.mock.calls[0] as [string, Date, number];
    expect(id).toBe("55555555-5555-5555-5555-555555555555");
    expect(limit).toBe(25);
    expect(Date.now() - since.getTime()).toBeGreaterThan(59 * 60 * 1000);
  });
});

describe("key store outage", () => {
  it("503s — never 401 — when the key LOOKUP throws, so a DB blip is not read as a bad credential", async () => {
    findActiveApiKeyByPlaintext.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const result = await authenticateApiRequest(request({ authorization: "Bearer sk_live_any" }), "cases:read");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("Retry-After")).toBe("30");
    const body = await result.response.json();
    expect(body.error).toBe("conflict");
    // The driver error must not reach the caller: it can carry connection strings, and this path
    // is reachable unauthenticated.
    expect(body.message).not.toContain("connection terminated");
  });

  it("503s and FAILS CLOSED when the rate reservation throws — an unrecordable request is refused", async () => {
    findActiveApiKeyByPlaintext.mockResolvedValue(keyRow(["cases:read"]));
    reserveApiKeyRequest.mockRejectedValue(new Error("deadlock detected"));
    const result = await authenticateApiRequest(request({ authorization: "Bearer sk_live_ok" }), "cases:read");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(touchApiKeyUsed).not.toHaveBeenCalled();
  });
});

describe("audit attribution", () => {
  it("labels the acting principal as the KEY, not the human who issued it", () => {
    expect(apiKeyActorLabel(keyRow(["cases:read"]))).toBe("api-key:epic-integration");
  });
});
