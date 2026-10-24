/**
 * A second signed-in user, for a test that needs somebody who is not the seeded admin: a person with no role (what a visitor who
 * registers is), or a mailbox of their own (notifications are per user, so a test that counts them must not share the admin's).
 *
 * The user registers through the real register page in a browser context of their own, which signs them in; the Auth.js session is a
 * stateless JWT, so this cannot end the admin session the other specs use. The test closes the context and deletes the user (the rows
 * that hang off the user cascade) in a `finally`: `withSecondUser` does both.
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { deleteUsersByEmail, pg } from "./db";
import { waitForHydration } from "./hydration";
import { unique } from "./unique";

export const SECOND_USER_PASSWORD = "Str0ng!Passw0rd";

export interface SecondUser {
  email: string;
  password: string;
  /** The user's id in the database (the notifications and roles of the user hang off it). */
  id: string;
  context: BrowserContext;
  page: Page;
}

/** Register a fresh user (unique e-mail) in a new browser context and wait until the app has signed them in. */
export async function registerSecondUser(browser: Browser, baseURL: string | undefined, prefix = "e2e-second-"): Promise<SecondUser> {
  const email = `${unique(prefix)}@example.com`.toLowerCase();
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
    await waitForHydration(page.getByTestId("register-form"));
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(SECOND_USER_PASSWORD);
    await page.getByLabel("Confirm Password", { exact: true }).fill(SECOND_USER_PASSWORD);
    await page.getByTestId("register-submit").click();
    // Registering hashes the password (bcrypt, 12 rounds) before it signs the user in.
    await expect(page).toHaveURL((url) => url.pathname === "/schemas", { timeout: 60_000 });
    const { rows } = await pg().query(`SELECT id FROM users WHERE email = $1`, [email]);
    const id = rows[0]?.id as string | undefined;
    if (!id) throw new Error(`the register page signed ${email} in, but there is no such user in the database`);
    return { email, password: SECOND_USER_PASSWORD, id, context, page };
  } catch (error) {
    await context.close();
    await deleteUsersByEmail([email]);
    throw error;
  }
}

/** Run `body` with a freshly registered user; the context is closed and the user deleted afterwards, whatever `body` does. */
export async function withSecondUser<T>(browser: Browser, baseURL: string | undefined, body: (user: SecondUser) => Promise<T>, prefix?: string): Promise<T> {
  const user = await registerSecondUser(browser, baseURL, prefix);
  try {
    return await body(user);
  } finally {
    await user.context.close();
    await deleteUsersByEmail([user.email]);
  }
}
