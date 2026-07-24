import "server-only";
import { getUserByOidc } from "@stopgap/db";

/**
 * Sign-in admission check (PHASE6 §6.1, CWE-285). Called from the Auth.js `signIn` callback
 * BEFORE the jwt upsert/role-minting, so a disabled account never gets a fresh token:
 *
 *  - no OIDC subject on the token → deny (an unidentifiable caller cannot be authorized);
 *  - a known user whose `disabledAt` is set → deny (Disable revokes access, not just visibility);
 *  - a new subject (never signed in) or an active user → allow (the jwt callback then upserts).
 *
 * Extracted from the callback so the rule is unit-testable without NextAuth or a live IdP — the
 * lookup is the only dependency, and tests mock it.
 */
export async function isSignInAllowed(subject: string | undefined | null): Promise<boolean> {
  if (!subject) return false;
  const user = await getUserByOidc(subject);
  return !user?.disabledAt;
}
