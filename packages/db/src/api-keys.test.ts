import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_SCOPES, generateApiKey, hashApiKey, isApiScope, reserveApiKeyRequest } from "./api-keys.js";

/**
 * The API key store (PHASE6 §6.7) — minting, hashing, scope narrowing, and the rate-limit
 * reservation. The minting properties need no database: they must hold regardless of what Postgres
 * does with the row, and they are what makes "a DB read cannot mint a usable key" true.
 *
 * The reservation is driven against a FAKE transaction rather than a real one. What matters there is
 * the decision — does `recent >= limit` admit or refuse, and does a refusal write nothing — and that
 * decision lives in this module, not in Postgres. Testing it through a container would test drizzle
 * and the advisory lock (already exercised by the demo-run limiter) while leaving the comparison
 * itself, the only part this file owns, unasserted.
 */

/** The rows a faked `db.transaction` reports as already sitting inside the window. */
let recentCount = 0;
const inserted = vi.fn();
const deleted = vi.fn();

vi.mock("./client.js", () => ({
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async () => undefined,
        delete: () => ({ where: async (...a: unknown[]) => deleted(...a) }),
        select: () => ({
          from: () => ({ where: async () => [{ n: recentCount }] }),
        }),
        insert: () => ({ values: async (...a: unknown[]) => inserted(...a) }),
      }),
  }),
}));

describe("generateApiKey", () => {
  it("returns a plaintext that is NOT the stored hash — the DB never holds the secret", () => {
    const { plaintext, keyHash } = generateApiKey();
    expect(plaintext).not.toBe(keyHash);
    // Nor is the plaintext recoverable from, or a substring of, what gets persisted.
    expect(keyHash).not.toContain(plaintext);
    expect(plaintext).not.toContain(keyHash);
  });

  it("hashes with SHA-256 hex, deterministically", () => {
    const { plaintext, keyHash } = generateApiKey();
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash).toBe(createHash("sha256").update(plaintext).digest("hex"));
    // Deterministic: the auth lookup hashes the presented secret and matches on this value, so a
    // second hash of the same plaintext MUST equal the first or no key would ever authenticate.
    expect(hashApiKey(plaintext)).toBe(keyHash);
  });

  it("prefixes the plaintext for display without exposing enough to authenticate", () => {
    const { plaintext, keyPrefix } = generateApiKey();
    expect(plaintext.startsWith("sk_live_")).toBe(true);
    // The prefix must belong to ITS OWN plaintext — the admin table shows it as an abbreviation of
    // the real key, so a prefix that is not one would mislabel the row.
    expect(plaintext.startsWith(keyPrefix)).toBe(true);
    expect(plaintext.length).toBeGreaterThan(keyPrefix.length + 32);
  });

  it("gives two independently minted keys DIFFERENT prefixes", () => {
    // The property the admin table depends on. Slicing at the `sk_live_` boundary satisfied every
    // assertion above while producing the identical literal for every key ever issued, which made
    // the "identify a key by its prefix" column decorative. Reach past the namespace and compare.
    const prefixes = new Set(Array.from({ length: 20 }, () => generateApiKey().keyPrefix));
    expect(prefixes.size).toBe(20);
    for (const prefix of prefixes) expect(prefix.startsWith("sk_live_")).toBe(true);
  });

  it("mints a distinct key every time", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe("isApiScope", () => {
  it("accepts every declared scope", () => {
    for (const scope of API_SCOPES) expect(isApiScope(scope)).toBe(true);
  });

  it("rejects unknown or non-string values — an unrecognized scope is dropped, never coerced", () => {
    expect(isApiScope("cases:write")).toBe(false);
    expect(isApiScope("admin")).toBe(false);
    expect(isApiScope("*")).toBe(false);
    expect(isApiScope("")).toBe(false);
    expect(isApiScope(undefined)).toBe(false);
    expect(isApiScope(null)).toBe(false);
    expect(isApiScope(42)).toBe(false);
  });
});

describe("reserveApiKeyRequest", () => {
  const KEY_ID = "55555555-5555-5555-5555-555555555555";
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    inserted.mockReset();
    deleted.mockReset();
  });

  function since(): Date {
    return new Date(Date.now() - WINDOW_MS);
  }

  it("admits a request UNDER the limit, counts it, and records it", async () => {
    recentCount = 4;
    const result = await reserveApiKeyRequest(KEY_ID, since(), 10);
    // `recent` is the count INCLUDING this reservation — a caller reporting "you have used N of M"
    // must not be off by one against the row it just wrote.
    expect(result).toEqual({ allowed: true, recent: 5 });
    expect(inserted).toHaveBeenCalledWith({ apiKeyId: KEY_ID });
  });

  it("refuses AT the limit and writes nothing — the boundary is >=, not >", async () => {
    recentCount = 10;
    expect(await reserveApiKeyRequest(KEY_ID, since(), 10)).toEqual({ allowed: false, recent: 10 });
    // The insert is what makes the next caller's count higher; a refused request that still wrote a
    // row would charge the key for a request it was never allowed to make.
    expect(inserted).not.toHaveBeenCalled();
  });

  it("refuses OVER the limit (a limit lowered under an already-busy key) and writes nothing", async () => {
    recentCount = 999;
    expect(await reserveApiKeyRequest(KEY_ID, since(), 10)).toEqual({ allowed: false, recent: 999 });
    expect(inserted).not.toHaveBeenCalled();
  });

  it("prunes aged-out rows even on the refusal path", async () => {
    // The saturated key is the one with the most accumulated rows; a prune placed after the
    // early return would never reach it.
    recentCount = 10;
    await reserveApiKeyRequest(KEY_ID, since(), 10);
    expect(deleted).toHaveBeenCalledTimes(1);
  });
});
