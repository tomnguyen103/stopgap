# Production CSP used the local Keycloak origin

## Symptom

The authenticated browser flow passed against local Keycloak but the production Compose build
could ship a CSP containing `http://localhost:8080` even when the running container redirected to
the public Keycloak domain.

## Root cause

Next serializes the `headers()` result while `next build` runs (`apps/console/next.config.ts:35-91`).
The production Compose file provided `KEYCLOAK_ISSUER` only in the service's runtime environment,
so `next.config.ts` fell back to the local issuer during the image build.

## Fix and receipt

`deploy/Dockerfile:42-46` accepts `KEYCLOAK_ISSUER` as a build argument and exposes it during the
Next build. Each production image build passes the public issuer from
`deploy/docker-compose.prod.yml:202-264`; the runtime environment continues to receive the same
value (`deploy/docker-compose.prod.yml:71`). The CSP tests cover both the local default and a
configured public issuer in `apps/console/next.config.test.ts:12-31`.
