# 01 — Stand up Keycloak with seeded per-role users

**What to build:** A person can sign in to the console as themselves and be recognised with their role. A local realm ships seeded with one user per role — viewer, pharmacist, pharmacy director, admin — so the authorization matrix is demonstrable from a clean checkout without anyone creating accounts by hand. Their identity flows into the audit chain, so "who authorized this" becomes a real user rather than an anonymous placeholder.

**Blocked by:** None — can start immediately

**Status:** done — merged as part of ticket 01

- [x] Signing in as each of the four seeded users succeeds and resolves that user's role
- [x] Roles arriving from identity-provider realm claims are unioned with locally granted roles, filtered to the known role set
- [x] With both auth secrets present, the deployment is no longer locked read-only and mutations matching the caller's role succeed
- [x] With either secret absent, no one can sign in, requests resolve to an anonymous viewer, and every mutating action is still refused — fails closed, never open
- [x] Demo mode continues to resolve a visitor to an anonymous viewer holding no mutating role
- [x] An approval performed by a signed-in user is attributable to that user's identity in the audit chain
- [x] The identity provider runs in the local stack and the deployment stack, and the local gate still needs no credentials to pass
