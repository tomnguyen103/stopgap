import { expect, type Page } from "@playwright/test";

/**
 * The four users seeded into the Keycloak realm by ticket 01 (`deploy/keycloak/realm-stopgap.json`),
 * with the dashboard each one's highest role lands on (`ROLE_LANDING_ROUTE`, ticket 03).
 *
 * Development credentials, in a development realm, checked in beside the realm that defines them.
 * They are not secrets and there is nothing to leak: the realm file is in the repository already,
 * and a browser tier that read its logins from an env var nobody sets is a tier that never runs.
 */
export const SEEDED_USERS = [
  { username: "viewer", password: "viewer-dev", landing: "/overview" },
  { username: "pharmacist", password: "pharmacist-dev", landing: "/queue" },
  { username: "director", password: "director-dev", landing: "/oversight" },
  { username: "admin", password: "admin-dev", landing: "/admin" },
] as const;

/**
 * Sign in through the real Keycloak form and land wherever the app sends us.
 *
 * Drives the IdP's own page rather than posting a token: the thing under test is the sign-in, and a
 * synthesised session would prove only that the test can forge one.
 */
export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  // Auth.js bounces an unauthenticated caller to its sign-in page; one provider is configured, so
  // the only button on it is Keycloak.
  const providerButton = page.getByRole("button", { name: /keycloak/i });
  if (await providerButton.isVisible().catch(() => false)) await providerButton.click();

  // Keycloak's own ids, not its label text: the label "Password" is shared with the show/hide
  // toggle button beside the field, and the theme's wording is not ours to depend on.
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();

  // Back on the console, not still on the IdP.
  await expect(page).toHaveURL(/localhost:3000/);
}
