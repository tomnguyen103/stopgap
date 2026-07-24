import "server-only";
import { getEnv, type Role } from "@stopgap/core";
import { auth } from "../../auth";

/**
 * Who is making this request (PHASE6 §6.1). Isolated in its own module so `auth-guards` and the
 * server actions depend on THIS, and tests can mock the session read without loading NextAuth or
 * the DB. `userId` is a real `users.id` for an authenticated caller, `null` for the anonymous
 * viewer (the public demo, or any unauthenticated request — which then fails every mutation gate).
 */
export interface Principal {
  userId: string | null;
  /** Human label for the audit chain's text `actor` field — email, name, or a sentinel. */
  label: string;
  roles: Role[];
  authenticated: boolean;
}

/**
 * Resolve the current principal from the Auth.js session, falling back to the anonymous viewer.
 * No session means the caller is a `viewer`: in demo mode that is the intended read-only guest;
 * outside demo it is an unauthenticated request the middleware would have redirected — either
 * way `viewer` holds no mutating role, so the guards refuse it.
 */
export async function resolvePrincipal(): Promise<Principal> {
  const session = await auth();
  if (session?.user?.id) {
    return {
      userId: session.user.id,
      label: session.user.email ?? session.user.name ?? session.user.id,
      roles: session.user.roles ?? [],
      authenticated: true,
    };
  }
  return {
    userId: null,
    label: getEnv().STOPGAP_DEMO_MODE === "on" ? "demo-viewer" : "anonymous",
    roles: ["viewer"],
    authenticated: false,
  };
}
