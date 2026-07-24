import "server-only";
import { assertRoleFor, type ConsoleAction } from "./authz";
import { resolvePrincipal, type Principal } from "./principal";

/**
 * The one line every mutating server action runs first (PHASE6 §6.1). A thin wrapper: resolve
 * the caller, then apply the PURE matrix in `authz.ts`. The authenticated principal is returned
 * so the action can thread `userId` (a real `users.id`) into the workflow signal and, from
 * there, the audit chain. Throws `AuthorizationError` (from `authz`) when the caller lacks the
 * required role — the same outcome for an anonymous demo viewer as for a signed-in pharmacist
 * attempting a director-only action: server-enforced, not merely hidden in the UI.
 */
export async function requireRole(action: ConsoleAction): Promise<Principal> {
  const principal = await resolvePrincipal();
  assertRoleFor(principal.roles, action);
  return principal;
}
