import { redirect } from "next/navigation";
import { ACCESS_DENIED_ROUTE, hasRecognizedRole, roleLandingRoute } from "./lib/authz";
import { resolvePrincipal } from "./lib/principal";

export const dynamic = "force-dynamic";

/**
 * The root sends every caller to their own dashboard (ticket 03).
 *
 * There is no landing page of its own, deliberately: a shared front door that everyone sees before
 * their real surface is a page nobody owns, and it is where "which dashboard am I supposed to be
 * on" stops being answerable.
 *
 * The resolution is `roleLandingRoute`, the pure function ticket 11's foundation already landed and
 * unit-tested — the HIGHEST role wins, mirroring `rolesAllow`'s "any role may satisfy" rule so
 * routing and permission cannot disagree about which role a multi-role user effectively holds.
 *
 * TOTAL, so this cannot loop: the anonymous demo visitor holds the real `viewer` role, whose landing
 * route is `/overview`, and the viewer group admits every role. So the one redirect lands somewhere
 * the guard will not bounce them out of again.
 *
 * The exception is a caller the IdP authenticated but granted NO recognized role — a realm missing
 * its Stopgap client mapper. They have no dashboard, so they get the access-denied route instead of
 * a landing route the group guard would immediately refuse them, which is the loop.
 */
export default async function RootPage() {
  const principal = await resolvePrincipal();
  if (!hasRecognizedRole(principal.roles)) redirect(ACCESS_DENIED_ROUTE);
  redirect(roleLandingRoute(principal.roles));
}
