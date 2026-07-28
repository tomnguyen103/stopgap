import { defineConfig, devices } from "@playwright/test";

/**
 * The browser smoke tier (ticket 04).
 *
 * DELIBERATELY NARROW, AND SEPARATE FROM `pnpm gate`. Only a few behaviours genuinely cannot be
 * proven below a browser: signing in, landing on the right dashboard, seeing an above-role control
 * refused, and the anonymous demo path. Everything expressible as a pure function stays in the
 * offline gate — sorting, filtering, searching and pagination are covered by the list-state unit
 * tests and are asserted NOWHERE here, because a broad browser suite that breaks on a class-name
 * change gets switched off within a month, and a switched-off suite proves nothing.
 *
 * `pnpm gate` never loads this file: the specs live in `e2e/` and the root vitest config excludes
 * that directory, so the default gate stays fully offline and needs no browser. The config lives
 * HERE rather than at the repository root so Playwright's loader picks up `e2e/tsconfig.json`
 * instead of the root project-references file, which it cannot resolve.
 *
 * TWO PROJECTS, because the two halves need the console running in mutually exclusive
 * configurations — a deployment is either wired to an IdP or in public-demo mode, never both:
 *
 *   pnpm infra:up && pnpm exec playwright install chromium
 *   pnpm console                                  # auth wired, demo off
 *   pnpm test:browser
 *   STOPGAP_DEMO_MODE=on pnpm console             # demo on
 *   pnpm test:browser:demo
 */
export default defineConfig({
  testDir: ".",
  // One worker: every spec signs in as a different seeded user against ONE Keycloak realm, and
  // parallel sign-ins race over the same cookie jar.
  workers: 1,
  fullyParallel: false,
  // A failing smoke test is a real failure, not a flake to paper over. No retries.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: process.env.STOPGAP_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "auth", testDir: "./auth", use: { ...devices["Desktop Chrome"] } },
    { name: "demo", testDir: "./demo", use: { ...devices["Desktop Chrome"] } },
  ],
});
