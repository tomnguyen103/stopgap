# Authentication & authorization (Phase 6 §6.1)

Stopgap authenticates console users through **OIDC SSO** (Auth.js / NextAuth v5) and authorizes
every mutating action through a **role matrix** enforced server-side. Identity flows into the
tamper-evident audit chain, so "who authorized this" is a machine-checkable `users.id`, not a
free-text string.

## Role matrix

Roles form a rank — a higher role satisfies any lower requirement:

```
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

Set `AUTH_SECRET` and `STOPGAP_DEMO_MODE=off` in `.env` to exercise the real sign-in + matrix
locally; leave them at defaults for the read-only demo.
