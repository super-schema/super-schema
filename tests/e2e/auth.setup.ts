/**
 * The `setup` project: one UI login per run, saved as the `storageState` every other project starts from (replaces the login that
 * every test used to do, and the fake session cookie of the layout spec).
 *
 * It carries both the @smoke and the @regression tag only so that a `--grep @smoke` / `--grep-invert "@slow|@external"` run does not
 * filter the login out of the projects that depend on it.
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
