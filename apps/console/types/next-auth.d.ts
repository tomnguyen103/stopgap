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
      roles: Role[];
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    roles?: Role[];
  }
}
