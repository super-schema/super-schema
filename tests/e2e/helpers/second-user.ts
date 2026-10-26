/**
 * A second signed-in user, for a test that needs somebody who is not the seeded admin: a person with the role a scenario needs (a viewer, an author, a
 * steward, ...), a person with no role at all (what a visitor who registers is), or a mailbox of their own (notifications are per user, so a test that
 * counts them must not share the admin's).
 *
 * The user is made THROUGH THE DATABASE HELPERS (`createUser`: the app's own password hash and e-mail normalization; `grantRole` per entry of `roles`), then
 * signs in through the real login form in a browser context of their own. The register page does not sign anybody in any more (open-mode registration
 * answers the same to a new and to a known address, so a new user is never signed in by it: access-control Task 4), and a user it makes holds no role, so
 * a helper that relied on it could neither sign in nor see anything. The Auth.js session is a stateless JWT, so a second context cannot end the admin
 * session the other specs use.
 *
 * `roles` says what the user holds: nothing given = no role at all (the user lands on /no-access); a role without a `scope` is held over the tenant the
 * seeded admin sees (`activeTenantId`); a scope names another tenant, a domain or a product (`RoleScope`, helpers/db.ts). The test closes the context and
 * deletes the user (the rows that hang off the user cascade) in a `finally`: `withSecondUser` does both. A user an audit row points at (they wrote something
 * in the app) cannot be deleted, and is left rather than failing the test (`deleteUsersBestEffort`).
 *
 * `registerThroughTheForm` is the one thing that still uses the register page: for a test OF registration (the user is made by the form, signed in by nothing,
 * and holds no role).
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { activeTenantId, createUser, deleteUsersBestEffort, grantRole, pg, type RoleScope } from "./db";
import { waitForHydration } from "./hydration";
import { unique } from "./unique";

export const SECOND_USER_PASSWORD = "Str0ng!Passw0rd";

/** A role the second user holds. No `scope` = over the tenant the seeded admin sees. */
export interface SecondUserRole {
  role: "VIEWER" | "AUTHOR" | "STEWARD" | "COMPLIANCE_OFFICER" | "ADMIN";
  scope?: RoleScope;
}

export interface SecondUserOptions {
  /** The start of the e-mail address (unique per call). */
  prefix?: string;
  /** What the user holds; none = no role at all. */
  roles?: readonly SecondUserRole[];
  name?: string;
}

export interface SecondUser {
  email: string;
  password: string;
  /** The user's id in the database (the notifications and roles of the user hang off it). */
  id: string;
  context: BrowserContext;
  page: Page;
}

/** Sign `email` in through the login form of `page` and wait until the app has taken them where they belong: the dashboard, or /no-access for a user with no role. */
export async function signInThroughTheForm(page: Page, email: string, password: string, expected: "dashboard" | "no-access" = "dashboard"): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await waitForHydration(page.getByTestId("login-form"));
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByTestId("login-submit").click();
  // The password is checked against a bcrypt hash of cost 12 before the session is made.
  const path = expected === "dashboard" ? "/schemas" : "/no-access";
  await expect(page).toHaveURL((url) => url.pathname === path, { timeout: 60_000 });
}

/**
 * Make a user with `options.roles` and sign them in through the login form, in a new browser context with no session of the admin's. The returned page is on the
 * dashboard (or on /no-access, when the user holds no role). The user is deleted again when anything of this fails.
 */
export async function registerSecondUser(browser: Browser, baseURL: string | undefined, options: SecondUserOptions | string = {}): Promise<SecondUser> {
  const { prefix = "e2e-second-", roles = [], name } = typeof options === "string" ? { prefix: options } : options;
  const email = `${unique(prefix)}@example.com`.toLowerCase();
  const { id } = await createUser({ email, password: SECOND_USER_PASSWORD, name });
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    for (const { role, scope } of roles) await grantRole(id, role, scope ?? { tenantId: await activeTenantId() });
    const page = await context.newPage();
    await signInThroughTheForm(page, email, SECOND_USER_PASSWORD, roles.length > 0 ? "dashboard" : "no-access");
    return { email, password: SECOND_USER_PASSWORD, id, context, page };
  } catch (error) {
    await context.close();
    await deleteUsersBestEffort([email]);
    throw error;
  }
}

/** Run `body` with a user who holds `options.roles`, signed in; the context is closed and the user deleted afterwards, whatever `body` does. */
export async function withSecondUser<T>(browser: Browser, baseURL: string | undefined, body: (user: SecondUser) => Promise<T>, options?: SecondUserOptions | string): Promise<T> {
  const user = await registerSecondUser(browser, baseURL, options);
  try {
    return await body(user);
  } finally {
    await user.context.close();
    await deleteUsersBestEffort([user.email]);
  }
}

export interface RegisteredVisitor {
  email: string;
  password: string;
  id: string;
  context: BrowserContext;
  page: Page;
}

/**
 * Register through the real register page (open mode), in a context of their own, and stop where the app does: on the login page, with the notice that the
 * account is ready, and NOT signed in. The user holds no role. The caller signs them in (`signInThroughTheForm`, which lands on /no-access) or checks
 * what the register page itself said. Remove with `deleteUsersBestEffort([email])` after closing the context.
 */
export async function registerThroughTheForm(browser: Browser, baseURL: string | undefined, prefix = "e2e-visitor-"): Promise<RegisteredVisitor> {
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
    // Registering hashes the password (bcrypt, cost 12) and answers the same whether the address was new or not: it signs nobody in.
    await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("notice") === "registered", { timeout: 60_000 });
    const { rows } = await pg().query(`SELECT id FROM users WHERE email = $1`, [email]);
    const id = rows[0]?.id as string | undefined;
    if (!id) throw new Error(`the register page accepted ${email}, but there is no such user in the database`);
    return { email, password: SECOND_USER_PASSWORD, id, context, page };
  } catch (error) {
    await context.close();
    await deleteUsersBestEffort([email]);
    throw error;
  }
}
