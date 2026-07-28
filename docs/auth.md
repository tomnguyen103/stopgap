# Authentication & authorization (Phase 6 §6.1)

Stopgap authenticates console users through **OIDC SSO** (Auth.js / NextAuth v5) and authorizes
every mutating action through a **role matrix** enforced server-side. Identity flows into the
tamper-evident audit chain, so "who authorized this" is a machine-checkable `users.id`, not a
free-text string.

## Role matrix

Roles form a rank — a higher role satisfies any lower requirement:

```text
viewer  <  pharmacist  <  pharmacy_director  <  admin
```

| Action (`ConsoleAction`)   | Minimum role       | Capability                                             |
| -------------------------- | ------------------ | ------------------------------------------------------ |
| _(read pages)_             | `viewer`           | Read-only console (cases, protocols, shadow, KPIs, audit) |
| `review_case`              | `pharmacist`       | Approve / edit / reject a case's drafted protocol       |
| `resolve_exception`        | `pharmacist`       | Resolve an exception-queue case                         |
| `approve_protocol_version` | `pharmacy_director`| Approve / supersede a protocol version directly         |
| `manage_users`             | `admin`            | Grant/revoke roles, disable accounts                    |
| `manage_spend_caps`        | `admin`            | Spend-cap configuration                                 |
| `manage_demo_config`       | `admin`            | Demo configuration                                      |

The matrix lives in one place — `apps/console/app/lib/authz.ts` (pure, no session/DB) — and is
unit-tested exhaustively (`auth-guards.test.ts`). Every mutating server action calls
`requireRole(action)` at its top; a caller who lacks the role gets an `AuthorizationError`
**on the server**, so hiding a button is never the security boundary. A pharmacist calling the
protocol-approval path fails exactly as an anonymous visitor does.

## Where roles come from

Two sources, unioned and filtered to the known role set:

1. **IdP realm roles** — `realm_access.roles` in the Keycloak token. This is how the seeded demo
   users get their role with no manual step.
2. **Local grants** — the `user_roles` table, managed by an admin at `/admin/users`.

The union and the filter live in `apps/console/app/lib/role-claims.ts` as pure functions, so the
rule is unit-tested without a live realm. The filter is a boundary rather than tidiness: a Keycloak
realm is shared infrastructure carrying built-in roles (`offline_access`, `uma_authorization`) and
roles belonging to every other client on it, and a name collision must not become a grant. Local
grants are filtered too, as belt-and-braces: `getUserRoles` already filters what it reads, but the
second check keeps the function total for any future caller, since a retired role riding into a
token would be compared against a rank that no longer contains it. A malformed or absent claim
yields no realm roles rather than throwing — this runs in the Auth.js `jwt` callback, where a throw
is a failed login for a legitimate user.

## Demo mode → anonymous viewer

When `STOPGAP_DEMO_MODE=on`, the middleware lets requests through **without** authentication and
they resolve to an anonymous `viewer`: the public demo stays fully functional read-only. Because
`viewer` holds no mutating role, every `requireRole` still refuses — the demo cannot approve,
resolve, or manage anything. The single demo mutation ("Run a shortage") is gated separately in
`@stopgap/demo`, not by a role.

## Honest non-configuration (no fake success)

Auth follows the same stance as comms non-delivery: a missing secret is recorded as unconfigured,
never faked. `authConfigured()` is true only when **both** `AUTH_SECRET` and
`KEYCLOAK_CLIENT_SECRET` are set. When it is false:

- the middleware does **not** redirect to a Keycloak that isn't wired — it lets requests through
  as the anonymous `viewer`, so the zero-config local gate and the public demo keep working;
- no one can sign in, so every mutation is refused. The deployment is locked read-only, not open.

To enforce the matrix in a real deployment: set `AUTH_SECRET` (e.g. `openssl rand -base64 33`),
set `KEYCLOAK_CLIENT_SECRET`, and turn `STOPGAP_DEMO_MODE=off`.

## Identity in the audit chain

`audit_log.actor` (text) stays the **hashed** identity field, unchanged — so the HMAC/SHA-256
chain verifies byte-for-byte across the RBAC migration. A new **un-hashed** FK
`audit_log.actor_user_id` carries the machine-checkable `users.id`. Server actions thread
`session.user.id` through the workflow signal into the append; workflow-internal actions resolve
the synthetic `system`/`agent` users. `protocol_versions` gains the same treatment
(`authored_by_user_id`, `approved_by_user_id` beside the text labels). The migration
(`0010_curly_invisible_woman.sql`) backfills legacy `system`/`agent` rows to the two synthetic
users and leaves human-labelled rows with a NULL FK and their text intact.

## Swapping the IdP (Azure AD / Okta)

Keycloak is the default because `docker compose up` can seed it. Any OIDC provider works — it is a
config change, not a code change:

1. Register a confidential OIDC client (redirect `https://<console>/api/auth/callback/keycloak`).
2. Point `KEYCLOAK_ISSUER` at the new issuer (e.g. `https://login.microsoftonline.com/<tenant>/v2.0`
   or `https://<org>.okta.com/oauth2/default`), and set `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET`.
3. Map the provider's group/role claim to `realm_access.roles`, or grant roles locally at
   `/admin/users`.

(The provider is still named `keycloak` internally — that is just the Auth.js provider id, which
speaks generic OIDC discovery; only the URLs change.)

## Local Keycloak (dev)

`docker compose up` starts Keycloak on `http://localhost:8080` and imports
`deploy/keycloak/realm-stopgap.json`:

- Admin console: `admin` / `admin` (DEV-ONLY).
- Demo users (DEV-ONLY passwords): `viewer`/`viewer-dev`, `pharmacist`/`pharmacist-dev`,
  `director`/`director-dev`, `admin`/`admin-dev`.

The seeded client secret is `stopgap-console-dev-secret` (DEV-ONLY). To exercise the real sign-in
+ matrix locally, set BOTH `AUTH_SECRET` and `KEYCLOAK_CLIENT_SECRET=stopgap-console-dev-secret`
in `.env`, plus `STOPGAP_DEMO_MODE=off` — auth stays unconfigured (read-only) if either secret is
missing. Leave them at defaults for the read-only demo.

### Verifying the seeded users without a browser

The realm's `realm-roles-in-id-token` mapper is what carries a user's role into the ID token that
Auth.js reads, so it is worth checking directly when changing the realm — the browser tier (ticket
04) proves the sign-in flow, this proves the claim shape:

The command below asks Keycloak for a token and then decodes the `id_token` payload, so it prints
the claim itself rather than an opaque string you would still have to paste somewhere to read:

```bash
curl -s -X POST http://localhost:8080/realms/stopgap/protocol/openid-connect/token -d grant_type=password -d scope=openid -d client_id=stopgap-console -d client_secret=stopgap-console-dev-secret -d username=director -d password=director-dev | jq -r .id_token | cut -d. -f2 | base64 -d 2>/dev/null | jq .realm_access.roles
```

It should print:

```json
[
  "pharmacy_director"
]
```

(`cut -d. -f2` takes the JWT's payload segment; `base64 -d` reports trailing-garbage on the
unpadded base64url JWTs use, which is why its stderr is discarded — the decode itself succeeds.)

The `id_token` payload must carry `realm_access.roles: ["pharmacy_director"]`. Omitting
`scope=openid` returns an access token only and no `id_token`, which looks like a broken realm and
is not one. Verified against `quay.io/keycloak/keycloak:26.0` for all four seeded users.

> **DEV-ONLY realm.** `deploy/keycloak/realm-stopgap.json` carries a fixed confidential client
> secret and known demo passwords (incl. an `admin`). It is imported ONLY by the dev
> `docker-compose.yml`. It is **never** imported in production — see below (CWE-798).

## Provisioning the production realm

The prod stack (`deploy/docker-compose.prod.yml`) starts Keycloak with `start` and **no**
`--import-realm`, and mounts nothing under `deploy/keycloak`. So no known privileged credential is
ever reachable by the prod stack. The operator provisions the realm once, out of band:

1. Reach the Keycloak admin console at `https://${AUTH_DOMAIN}` and sign in with the bootstrap
   admin (`KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` from `deploy/.env`). Rotate that
   password after first login.
2. Create the `stopgap` realm and the four realm roles (`viewer`, `pharmacist`,
   `pharmacy_director`, `admin`).
3. Create a confidential `stopgap-console` OIDC client: redirect URI
   `https://${APP_DOMAIN}/api/auth/callback/keycloak`, and a protocol mapper that emits realm
   roles into the token as `realm_access.roles`. Generate a fresh client secret.
4. Put that secret in `deploy/.env` as `KEYCLOAK_CLIENT_SECRET`, set `AUTH_SECRET`
   (`openssl rand -base64 33`), set `STOPGAP_DEMO_MODE=off`, and redeploy.
5. Create real users (or federate your directory) and assign roles — or grant them locally at
   `/admin/users` once an admin exists.

Until step 4 is done, `KEYCLOAK_CLIENT_SECRET` is blank, `authConfigured()` is false, and the
console runs read-only as the anonymous viewer — honest non-configuration, not a faked sign-in.
