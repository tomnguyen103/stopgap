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
  test("reaches the viewer dashboard without signing in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/overview$/);
    // The banner is the honest label on a read-only deployment; its absence would mean the console
    // is NOT in demo mode and this whole spec is asserting against the wrong configuration.
    await expect(page.getByText(/read-only demo/i)).toBeVisible();
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

  test("is refused when it ATTEMPTS a mutation anyway", async ({ request }) => {
    // The absence of a button is not the guarantee — the server refusing is. A hand-crafted
    // request bypasses the rendered surface entirely, which is exactly what an attacker does.
    const response = await request.post("/api/v1/cases/any-key/review", {
      data: { kind: "approve", reviewer: "anonymous" },
      failOnStatusCode: false,
    });
    // PINNED, and honest about which door closed. A bare `>= 400` conflated two refusals; the
    // route authenticates BEFORE `demoGateOr403`, so a caller with no API key is turned away at
    // 401 and never reaches the demo gate at all. What this test proves is therefore the auth
    // boundary — that a hand-rolled request from a demo visitor cannot mutate — and pinning the
    // exact status is what makes it fail if that boundary ever softens to a redirect or a 200.
    //
    // The demo gate's own 403 is a DIFFERENT claim, reachable only with a valid key, and no test
    // covers it yet: see the note on the batch B pull request.
    expect(
      response.status(),
      "an anonymous mutation must be refused by the API key check, before any other gate",
    ).toBe(401);
  });
});
