/**
 * The `setup` project: one UI login per run, saved as the `storageState` every other project starts from (replaces the login that
 * every test used to do, and the fake session cookie of the layout spec).
 *
 * As a dependency it always runs in full, whatever the tier filter says. It carries the @smoke and @regression tags so that it is also
 * picked when it is selected on its own with a tier filter (`--project=setup --grep @smoke`).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { AUTH_STATE_PATH, login } from "./helpers/auth-state";

setup("log in once as the seeded admin and save the session", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
  await login(page);
  // Past the login form AND an authenticated page: the session cookie is what every other project loads.
  await page.goto("/schemas");
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
  mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
