import type { Role } from "@stopgap/core";
import type { DefaultSession } from "next-auth";

/**
 * Module augmentation for Auth.js (PHASE6 §6.1): the session and JWT carry the local `users.id`
 * and the caller's roles, so `resolvePrincipal`/`requireRole` read a typed principal instead of
 * `any`. Kept in `types/` (covered by the tsconfig ts-file include) so it applies app-wide.
 */
declare module "next-auth" {
  interface Session {
    user: {
      /** Local `users.id` (the value threaded into the audit chain). */
      id: string;
      /**
       * The tenant this user belongs to — `users.org_id` (PHASE6 §6.5). Baked into the JWT at
       * sign-in beside the roles, for the same reason: the request path must be able to scope a
       * query without a DB round-trip on every render, and the value cannot change mid-session
       * because a sign-in never rewrites an existing user's org (see `UpsertUserInput`).
       */
      orgId: string;
      roles: Role[];
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    /** `users.org_id` of the signed-in user (PHASE6 §6.5). */
    orgId?: string;
    roles?: Role[];
  }
}
