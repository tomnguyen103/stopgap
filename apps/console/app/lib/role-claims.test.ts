import { describe, expect, it } from "vitest";
import { realmRolesFromProfile, resolveRoles } from "./role-claims";

/**
 * The role-resolution seam ticket 01 names: "roles arriving from identity-provider realm claims
 * are unioned with locally granted roles, filtered to the known role set". It is pure — no token,
 * no session, no DB — so every shape a real IdP can present is asserted offline rather than
 * discovered when a live realm sends something unexpected.
 */
describe("realmRolesFromProfile", () => {
  it("reads the realm roles a Keycloak ID token carries", () => {
    // The exact claim shape the seeded realm's `realm-roles-in-id-token` mapper emits, verified
    // against a live container: `realm_access.roles` as a multivalued string array.
    expect(realmRolesFromProfile({ realm_access: { roles: ["pharmacy_director"] } })).toEqual([
      "pharmacy_director",
    ]);
  });

  it("drops a realm role this build does not know", () => {
    // An IdP is shared infrastructure and will legitimately assert roles for other applications.
    // Trusting one would be a privilege the deployment never granted.
    expect(
      realmRolesFromProfile({ realm_access: { roles: ["pharmacist", "offline_access"] } }),
    ).toEqual(["pharmacist"]);
  });

  it.each([
    ["no profile", undefined],
    ["null profile", null],
    ["no realm_access", {}],
    ["realm_access without roles", { realm_access: {} }],
    ["roles not an array", { realm_access: { roles: "admin" } }],
    ["non-string entries", { realm_access: { roles: [1, null, {}] } }],
  ])("yields no roles for %s rather than throwing", (_label, profile) => {
    // This runs inside the sign-in callback. A throw here is a failed login for a legitimate user,
    // so a malformed claim degrades to "no realm roles" — they keep whatever was granted locally.
    expect(realmRolesFromProfile(profile)).toEqual([]);
  });
});

describe("resolveRoles", () => {
  it("unions local grants with realm claims", () => {
    expect(resolveRoles(["pharmacist"], { realm_access: { roles: ["admin"] } })).toEqual([
      "pharmacist",
      "admin",
    ]);
  });

  it("does not repeat a role granted in both places", () => {
    expect(resolveRoles(["admin"], { realm_access: { roles: ["admin"] } })).toEqual(["admin"]);
  });

  it("keeps a local grant the IdP knows nothing about", () => {
    // The whole point of local grants: an administrator corrects access without an IdP change.
    expect(resolveRoles(["pharmacy_director"], { realm_access: { roles: [] } })).toEqual([
      "pharmacy_director",
    ]);
  });

  it("filters a local grant that is no longer a known role", () => {
    // `user_roles` rows outlive code. A role removed from this build must not survive in a token.
    expect(resolveRoles(["pharmacist", "superuser"] as never, null)).toEqual(["pharmacist"]);
  });

  it("yields no roles when neither source grants any", () => {
    // Not "viewer": an empty set is what `resolvePrincipal` turns into the anonymous viewer, and
    // synthesising a role here would mean a token that asserts something the IdP did not.
    expect(resolveRoles([], null)).toEqual([]);
  });
});
