/**
 * The `setup` project: one UI login per run, saved as the `storageState` every other project starts from (replaces the login that
 * every test used to do, and the fake session cookie of the layout spec).
 *
 * As a dependency it always runs in full, whatever the tier filter says. It carries the @smoke and @regression tags so that it is also
 * picked when it is selected on its own with a tier filter (`--project=setup --grep @smoke`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { AUTH_STATE_PATH, cookiesOnly, login } from "./helpers/auth-state";

setup("log in once as the seeded admin and save the session", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
  await login(page);
  // Past the login form AND an authenticated page: the session cookie is what every other project loads.
  await page.goto("/schemas");
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
  mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  // Cookies only: the page's localStorage (panel widths and the like, written while this page was open) must not reach the other tests.
  writeFileSync(AUTH_STATE_PATH, JSON.stringify(cookiesOnly(await page.context().storageState()), null, 2));
  const saved = JSON.parse(readFileSync(AUTH_STATE_PATH, "utf8")) as { cookies: Array<{ name: string }>; origins: unknown[] };
  expect(saved.origins, "the saved login must not carry any page storage").toEqual([]);
  expect(saved.cookies.some((cookie) => /session-token/.test(cookie.name)), "the saved login has no session cookie").toBe(true);
});
