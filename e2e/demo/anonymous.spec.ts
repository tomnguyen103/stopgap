import { expect, test } from "@playwright/test";

/**
 * The anonymous public-demo path (ticket 04).
 *
 * Run against a console started with `STOPGAP_DEMO_MODE=on`. A visitor with no session resolves to
 * the viewer role, so the demo and the lowest-privilege surface are ONE thing rather than a second
 * code path that could drift from it.
 *
 * The second half is the half that matters: reaching the dashboard is a feature, being unable to
 * change anything is the guarantee. `assertMutationAllowed` refuses every mutating server action in
 * demo mode, and the console renders no control that would call one.
 */
test.describe("the anonymous demo visitor", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("reaches the viewer dashboard without signing in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/overview$/);
    // The banner is the honest label on a read-only deployment; its absence would mean the console
    // is NOT in demo mode and this whole spec is asserting against the wrong configuration.
    await expect(page.getByText(/demo/i).first()).toBeVisible();
  });

  test("cannot reach a dashboard above the viewer role", async ({ page }) => {
    await page.goto("/admin");
    // Redirected to their own landing route rather than shown an error: the group guard sends a
    // caller to the surface they DO hold.
    await expect(page).toHaveURL(/\/overview$/);
  });

  test("is offered no control that would mutate", async ({ page }) => {
    await page.goto("/overview");
    for (const label of [/approve/i, /review/i, /resolve/i, /revoke/i, /issue key/i]) {
      await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }
  });
});
