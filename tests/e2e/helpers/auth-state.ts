/**
 * Who the suite logs in as, where that login is kept, and the UI login that produces it.
 *
 * Kept free of anything that needs the Playwright test runner (a type import only), so playwright.config.ts, the setup project, the
 * fixtures and the DB helpers can all import it without loading each other.
 *
 * PREREQS (cannot be auto-run without these):
 *   - A reachable database and a seeded user: `npm run db:seed` (the release runner of Task 2 provisions both). TEST_EMAIL / TEST_PASSWORD
 *     override the seeded admin.
 *   - `npx playwright install chromium` once (firefox and webkit too for the cross-browser smoke projects).
 */
import path from "node:path";
import type { Page } from "@playwright/test";

export const TEST_EMAIL = process.env.TEST_EMAIL ?? "admin@admin.com";
export const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "admin";

/**
 * The admin's session, written by the `setup` project (tests/e2e/auth.setup.ts) with one UI login per run and read by every other
 * project as its `storageState`. Git-ignored (`playwright/.auth/`): a login is never committed, and never reused from an earlier run
 * (the setup project rewrites it first, because every project depends on it).
 */
export const AUTH_STATE_PATH = path.resolve(__dirname, "../../../playwright/.auth/admin.json");

/** Log in through the login form. Success = the page leaves /login (a wrong password surfaces as a timeout on that). */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}
