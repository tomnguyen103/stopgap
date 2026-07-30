import { expect, test } from "@playwright/test";
import { SEEDED_USERS, signIn } from "./sign-in";

/**
 * Signing in, and landing on the right dashboard (ticket 04).
 *
 * The one thing no unit test can prove. `roleLandingRoute` is already covered as a pure function;
 * what is NOT covered below a browser is that a real Keycloak session, a real middleware pass and a
 * real redirect chain end at the route that function names.
 *
 * Playwright gives every test its own browser context, so one signed-in session cannot satisfy the
 * next assertion by accident.
 */
for (const user of SEEDED_USERS) {
  test.describe(`${user.username}`, () => {
    test(`signs in and lands on ${user.landing}`, async ({ page }) => {
      await signIn(page, user.username, user.password);
      await expect(page).toHaveURL(new RegExp(`${user.landing}$`));
    });
  });
}

test.describe("an above-role control", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("renders refused and names the role it would take", async ({ page }) => {
    // The pharmacist may review a case but not approve a protocol version — approval is the
    // director's call (`ACTION_MIN_ROLE.approve_protocol_version`).
    await signIn(page, "pharmacist", "pharmacist-dev");
    await page.goto("/protocols");

    const approve = page.getByRole("button", { name: /approve/i });
    // FAILS rather than skips when there is nothing to gate. A skip here would let the one
    // assertion that covers this ticket's disabled-control requirement vanish silently the day the
    // fixture data changed, and the tier would still report green.
    await expect(
      approve,
      "the auth tier needs at least one DRAFTED protocol version to gate — `pnpm test:browser` " +
        "writes one first (`pnpm test:browser:seed`); running playwright directly skips that",
    ).not.toHaveCount(0);
    const first = approve.first();

    // REFUSED, NOT HIDDEN, and still reachable by keyboard: `aria-disabled` rather than `disabled`,
    // so the explanation stays in the tab order for the people who most need it.
    await expect(first).toHaveAttribute("aria-disabled", "true");
    await expect(first).toHaveAccessibleName(/requires the pharmacy director role/i);
  });
});
