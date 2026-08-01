# Readiness must expose fail-closed authentication

## Symptom

Non-demo console routes correctly returned `503 authentication_not_configured` when either auth
secret was missing, but the console's readiness endpoint and production container healthcheck still
reported healthy. A deployment could therefore stay in rotation while every user-facing route was
unavailable.

## Root cause

`apps/console/middleware.ts:47-59` enforced the authentication posture at request time, while
`apps/console/app/api/readyz/route.ts:33-40` only considered Postgres, Temporal and the maintenance
connection. `deploy/docker-compose.prod.yml:211-219` also probed the always-200 liveness endpoint,
so it could not observe the fail-closed route state.

## Fix

`apps/console/app/api/readyz/route.ts:35-46` now treats explicit demo mode as intentionally
anonymous and requires `authConfigured` for non-demo readiness. The response exposes the
authentication check without secrets. `deploy/docker-compose.prod.yml:211-220` probes `/api/readyz`
so the container health state follows the route's real serving posture. Liveness remains separately
available at `/api/healthz`.

## Regression coverage

`apps/console/app/api/readyz/route.test.ts:25-61` covers demo-without-auth, non-demo missing auth
and configured non-demo readiness. The full gate and production image build remain required.
