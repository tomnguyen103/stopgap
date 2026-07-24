import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRow } from "@stopgap/db";

/**
 * Sign-in admission tests (PHASE6 §6.1, CWE-285). The user lookup is mocked, so the disabled-user
 * denial is proven without NextAuth, a live IdP, or a database.
 */

vi.mock("server-only", () => ({}));

const getUserByOidc = vi.fn<(subject: string) => Promise<UserRow | undefined>>();
vi.mock("@stopgap/db", () => ({ getUserByOidc: (s: string) => getUserByOidc(s) }));

const { isSignInAllowed } = await import("./sign-in-guard");

function user(overrides: Partial<UserRow>): UserRow {
  return {
    id: "u1",
    oidcSubject: "sub-1",
    email: "u@x.test",
    displayName: "U",
    createdAt: new Date(),
    disabledAt: null,
    ...overrides,
  } as UserRow;
}

beforeEach(() => {
  getUserByOidc.mockReset();
});

describe("isSignInAllowed", () => {
  it("DENIES a disabled account (Disable revokes access, not just visibility)", async () => {
    getUserByOidc.mockResolvedValue(user({ disabledAt: new Date() }));
    expect(await isSignInAllowed("sub-1")).toBe(false);
    expect(getUserByOidc).toHaveBeenCalledWith("sub-1");
  });

  it("allows an active existing user", async () => {
    getUserByOidc.mockResolvedValue(user({ disabledAt: null }));
    expect(await isSignInAllowed("sub-1")).toBe(true);
  });

  it("allows a new subject that has never signed in", async () => {
    getUserByOidc.mockResolvedValue(undefined);
    expect(await isSignInAllowed("sub-new")).toBe(true);
  });

  it("denies a token with no subject", async () => {
    expect(await isSignInAllowed(undefined)).toBe(false);
    expect(await isSignInAllowed(null)).toBe(false);
    // Never even reaches the lookup.
    expect(getUserByOidc).not.toHaveBeenCalled();
  });
});
