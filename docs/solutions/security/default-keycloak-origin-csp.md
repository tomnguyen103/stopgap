# Default Keycloak origin was missing from the CSP

## Symptom

The authenticated Playwright tier could reach Auth.js's sign-in page, but Chromium never reached
Keycloak. The browser console reported that posting the sign-in form violated `form-action 'self'`.

## What did not work

Supplying `AUTH_SECRET` and the seeded Keycloak client secret was not enough. The provider redirect
was healthy, but the CSP still blocked the form submission before the redirect could occur.

## Root cause

The console's environment parser supplies `http://localhost:8080/realms/stopgap` as the default
issuer (`packages/core/src/env.ts:174`), while the CSP builder only examined the raw
`KEYCLOAK_ISSUER` process variable (`apps/console/next.config.ts:51-55`). A normal local launch
therefore emitted `form-action 'self'` even though the app was configured to use local Keycloak.

The same zero-configuration path also called Auth.js from principal resolution despite
`authConfigured` being false. That produced `MissingSecret` log noise during the otherwise working
anonymous demo (`apps/console/app/lib/principal.ts:88-88,160-160`).

## Fix

The CSP now derives its allowed origin from the same local Keycloak default when no issuer variable
is set (`apps/console/next.config.ts:51-53`). Principal resolution skips Auth.js entirely when the
IdP is not configured, while configured deployments still read the real session
(`apps/console/app/lib/principal.ts:88-88,160-160`).

## Regression coverage

- `apps/console/next.config.test.ts` proves the default issuer origin is present in
  `form-action`.
- `apps/console/app/lib/principal.test.ts` proves demo resolution does not initialize Auth.js.
- Authenticated browser smoke: 5 passed.
- Anonymous demo browser smoke: 4 passed.
