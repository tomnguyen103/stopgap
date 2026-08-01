# A first-cut CSP broke sign-in, then broke every button in `pnpm dev`

## Problem

Adding security headers to `apps/console/next.config.ts` (design-direction P4.5) shipped a
Content-Security-Policy that looked correct by inspection and broke the console twice. Neither
failure produced a build error, a lint error, a type error or a failing unit test.

1. **Nobody could sign in.** Clicking "Sign in with Keycloak" did nothing.
2. **Every interactive control was dead under `pnpm dev`** — buttons, toggles, dialogs, forms, on
   every page. The pages rendered correctly and were completely inert.

## What did not work

- **Reading the policy.** Both directives are same-origin-looking and read as obviously safe.
- **Blaming the environment.** The four `pnpm test:browser` auth specs were failing at
  `page.locator("#username")`, and the first diagnosis recorded was "the local Keycloak realm has
  no seeded users". The realm file at `deploy/keycloak/realm-stopgap.json` has all four users and
  the right redirect URIs; the realm endpoint answered 200. That diagnosis was wrong.
- **Unit tests.** `apps/console/app/motion.test.ts` and friends assert the stylesheet, not the
  response headers. Nothing offline can see a CSP.

## Root cause

### 1. `form-action 'self'` blocks an OIDC sign-in

Auth.js's sign-in page POSTs to `/api/auth/signin/keycloak` — same origin. The RESPONSE to that
POST is a 302 to the IdP, on a different origin. **Chrome evaluates `form-action` against every hop
of the redirect chain, not just the form's `action` attribute.** So the same-origin POST is blocked
because of where it ends up:

```
Sending form data to 'http://localhost:3000/api/auth/signin/keycloak' violates the following
Content Security Policy directive: "form-action 'self'". The request has been blocked.
```

Any CSP on an app that federates to an external IdP has to allow that IdP's origin in
`form-action`.

### 2. `script-src` without `'unsafe-eval'` stops React hydrating in development

Webpack's development build evaluates module code as strings to support source maps. Without
`'unsafe-eval'` the bundle throws before hydration, so the server-rendered HTML is all the browser
ever gets — correct-looking and completely inert:

```
Evaluating a string as JavaScript violates the following Content Security Policy directive
because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'unsafe-inline'
```

The production build emits no `eval`, so this is a development-only requirement — and the reason it
is easy to ship: `pnpm build` succeeds and the deployed console works.

## Fix

Both in [`apps/console/next.config.ts`](../../../apps/console/next.config.ts), in the `headers()`
callback:

- Derive the IdP origin from the configured issuer and add it to `form-action`. Empty when no IdP
  is configured, because a demo deployment has no third origin to allow.
- Add `'unsafe-eval'` to `script-src` when `process.env.NODE_ENV !== "production"`, and only then.

## How to catch this class of bug

A CSP is a property of the RESPONSE and of the BROWSER, so nothing in the offline gate can see it.
The check that found both was driving the running console with Playwright and listening:

```js
page.on("pageerror", (e) => console.log(e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log(m.text());
});
```

Then: sign in, and press Enter on one interactive control. If hydration is dead, every control is
dead, so one is enough to prove it.

`pnpm test:browser` also covers case 1 — the auth tier fails at the Keycloak login form when
`form-action` is wrong. It does not cover case 2, because Playwright drives whatever the server is
serving and the browser tier is normally pointed at a production build.
