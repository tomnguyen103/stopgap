import { redirect } from "next/navigation";
import { roleLandingRoute } from "./lib/authz";
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
 * TOTAL, so this cannot loop: a caller with no roles at all — the anonymous demo visitor — resolves
 * to `viewer`, whose landing route is `/overview`, and the viewer group admits every role. So the
 * one redirect lands somewhere the guard will not bounce them out of again.
 */
export default async function RootPage() {
  const principal = await resolvePrincipal();
  redirect(roleLandingRoute(principal.roles));
}
