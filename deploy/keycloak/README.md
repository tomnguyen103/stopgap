# Keycloak realm seed — DEV-ONLY

`realm-stopgap.json` is a **development-only** Keycloak realm export. It is imported ONLY by the
dev stack (`docker-compose.yml`, `keycloak` service, `--import-realm`) so that
`docker compose up` yields a working IdP with zero configuration.

**Never import this file in production.** It intentionally carries credentials that must not exist
in a real deployment (CWE-798):

- a **fixed confidential client secret** (`stopgap-console-dev-secret`) for `stopgap-console`;
- **known demo passwords** for one user per role, including an `admin` account (`admin-dev`).

The production stack (`deploy/docker-compose.prod.yml`) starts Keycloak with `start` and **no**
`--import-realm` and does **not** mount this directory. The operator provisions the prod realm,
`stopgap-console` client, users, and a freshly generated client secret out of band — see
`docs/auth.md` → "Provisioning the production realm". Until that is done, auth is honestly
unconfigured (blank `KEYCLOAK_CLIENT_SECRET`) and the console runs read-only.
