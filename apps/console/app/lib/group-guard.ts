import "server-only";
import { redirect } from "next/navigation";
import { canViewGroup, roleLandingRoute, type DashboardGroup } from "./authz";
import { resolvePrincipal } from "./principal";

/**
 * The server-side gate on a dashboard group (ticket 03).
 *
 * Called by each group's LAYOUT, which is the only place session state is read — the root layout
 * stays static, so every route in the app is not forced to re-render per session.
 *
 * A caller who may not see this group is REDIRECTED to their own landing route, which is the same
 * treatment an unauthenticated request already gets from the middleware: a redirect, no content,
 * and nothing rendered that would say what is behind the URL. A 404 was the alternative; a
 * redirect was chosen because it also answers the question the caller actually had — "where is my
 * dashboard" — instead of leaving them at a dead end.
 *
 * REACHING A ROUTE GRANTS NOTHING. This decides visibility only. Every page still reads its own
 * data through its own guard and every server action still calls `requireRole`, exactly as before.
 */
export async function requireGroup(group: DashboardGroup): Promise<Awaited<ReturnType<typeof resolvePrincipal>>> {
  const principal = await resolvePrincipal();
  if (!canViewGroup(principal.roles, group)) redirect(roleLandingRoute(principal.roles));
  return principal;
}
