# Next.js server-action export surface

## Problem

The first implementation of the anonymous demo quota exported the cookie-name constant from
`apps/console/app/lib/actions.ts`. The route worked through TypeScript and unit tests, but a real
Next development render failed with `Only async functions are allowed to be exported in a "use
server" file`.

## Root cause

The module-level `"use server"` directive makes every export part of Next's server-action boundary.
`apps/console/app/lib/actions.ts:1` therefore cannot export a synchronous constant alongside its
async actions.

## Fix

Keep the cookie name module-private in `apps/console/app/lib/actions.ts:77` and expose no new
non-action export. The quota remains exercised through the async `startDemoShortage` action, and
the browser proof now compiles the page before asserting its runtime behavior.
