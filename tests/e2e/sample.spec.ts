import { test, expect } from "./helpers/fixtures";

// The public entrance: no saved login, so this is what a visitor gets.
test.use({ storageState: { cookies: [], origins: [] } });

test("app loads", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Super Schema/i);
});
