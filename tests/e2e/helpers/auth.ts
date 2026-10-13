import { test as base, expect, type Page } from "@playwright/test";

/**
 * E2E auth + fixtures.
 *
 * PREREQS (cannot be auto-run in CI without these):
 *   - A reachable database (DB_PROVIDER=pglite works zero-config; postgres needs DATABASE_URL).
 *   - A seeded user. Set TEST_EMAIL / TEST_PASSWORD, or seed one via `npm run db:seed`.
 *   - `npx playwright install chromium` once.
 * Run: `npm run test:e2e` (playwright.config starts the app via `npm run build && npm start`).
 */

export const TEST_EMAIL = process.env.TEST_EMAIL ?? "admin@admin.com";
export const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "admin";

export async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  // Success = we leave /login. (Surfaces a clear error if creds are wrong.)
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

/** A unique suffix so repeated runs don't collide on names/slugs. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

/** Authenticated-page fixture. */
export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await login(page);
    await use(page);
  },
});

export { expect };
