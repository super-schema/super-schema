/**
 * Authentication, through the real login and register pages and the user menu.
 *
 * Every test here starts logged OUT (`test.use({ storageState: ... })` below replaces the admin session the `setup` project saved), so
 * the tests use `page`, never `authedPage`. A test that needs a session of its own logs in through the form in its own browser
 * context; the JWT session of Auth.js is stateless, so signing one out cannot end the admin session the other specs use.
 *
 * What the app really does (checked, not assumed):
 *   - the middleware sends a visitor without a session cookie to a bare `/login` (no callbackUrl), and the login form always goes to
 *     `/schemas` afterwards: a deep link is NOT returned to (one test says so);
 *   - a signed-in visitor on /login or /register is sent to `/schemas`;
 *   - registering signs the new user in and lands on `/schemas`.
 *
 * `login-form` / `register-form` are client forms: until React has hydrated them the browser would submit them natively (a GET with
 * the password in the address), so each test waits for the form's hydration before it types (`waitForHydration`).
 */
import type { Page } from "@playwright/test";
import { AUTH_STATE_PATH, TEST_EMAIL, TEST_PASSWORD } from "./helpers/auth-state";
import { deleteUsersByEmail, disconnectDb } from "./helpers/db";
import { test, expect as baseExpect, unique } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";

/**
 * Every assertion below waits for the server: a page render, a password check, or a server action. Measured on the hierarchy spec (the same server work): a domain is
 * created in 0.1 s when the suite runs with one worker (as CI does), and in 4 s when eight workers use the one server, which is
 * just under `expect`'s default 5 s and what made the first version of these specs fail now and then. They wait up to the 30 s of
 * `actionTimeout` (playwright.config.ts) instead; an assertion that holds returns at once.
 */
const expect = baseExpect.configure({ timeout: 30_000 });

test.use({ storageState: { cookies: [], origins: [] } });

/** Test ids of the login and register pages (src/app/(auth)) and of the user menu (src/components/layout/TopBar.tsx). */
const ID = {
  loginForm: "login-form",
  loginEmail: "login-email",
  loginPassword: "login-password",
  loginSubmit: "login-submit",
  loginError: "login-error",
  loginToggle: "login-password-toggle",
  registerLink: "login-register-link",
  registerForm: "register-form",
  registerEmail: "register-email",
  registerPassword: "register-password",
  registerConfirm: "register-confirm-password",
  registerSubmit: "register-submit",
  registerToggle: "register-password-toggle",
  registerConfirmToggle: "register-confirm-password-toggle",
  registerEmailError: "register-email-error",
  registerConfirmError: "register-confirm-password-error",
  registerLoginLink: "register-login-link",
  userMenu: "user-menu",
  userEmail: "user-email",
  signOut: "sign-out",
  topbar: "topbar",
} as const;

const INVALID_CREDENTIALS = "Invalid email or password";
const REGISTER_PASSWORD = "Str0ng!Passw0rd";

/** Registered by a test through the UI; removed afterwards so the admin's user list does not grow with every run. */
const registeredEmails: string[] = [];

test.afterAll(async () => {
  try {
    await deleteUsersByEmail(registeredEmails);
  } catch (error) {
    console.warn(`auth.spec cleanup failed for ${registeredEmails.join(", ")}: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

async function openLogin(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await waitForHydration(page.getByTestId(ID.loginForm));
}

async function openRegister(page: Page): Promise<void> {
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
  await waitForHydration(page.getByTestId(ID.registerForm));
}

async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.getByTestId(ID.loginEmail).fill(email);
  await page.getByTestId(ID.loginPassword).fill(password);
  await page.getByTestId(ID.loginSubmit).click();
}

async function fillRegister(page: Page, email: string, password: string, confirmation = password): Promise<void> {
  await page.getByTestId(ID.registerEmail).fill(email);
  await page.getByTestId(ID.registerPassword).fill(password);
  await page.getByTestId(ID.registerConfirm).fill(confirmation);
}

/** The page is the signed-in dashboard: the top bar is there, and the user menu names the user. */
async function expectSignedInAs(page: Page, email: string): Promise<void> {
  await expect(page.getByTestId(ID.topbar)).toBeVisible();
  await page.getByTestId(ID.userMenu).click();
  await expect(page.getByTestId(ID.userEmail)).toHaveText(email);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(ID.userEmail)).toHaveCount(0);
}

const pathnameOf = (page: Page): string => new URL(page.url()).pathname;

/**
 * Signing in ends with a navigation to /schemas, which renders the dashboard for the first time in that browser context (and the
 * server checks a password first): longer than an assertion's usual 5 s when the whole suite runs at once, as `login()` of
 * helpers/auth-state.ts already allows. Registering also hashes the password with bcrypt (12 rounds) first.
 */
async function expectLandedOnSchemas(page: Page, timeout = 30_000): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === "/schemas", { timeout });
}

test.describe("login", () => {
  test("a valid login lands on /schemas, signed in as that user", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);

    await expectLandedOnSchemas(page);
    await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    await expectSignedInAs(page, TEST_EMAIL);
    expect(
      (await page.context().cookies()).some((cookie) => /session-token/.test(cookie.name)),
      "login did not set a session cookie",
    ).toBe(true);
  });

  test("a wrong password shows 'Invalid email or password' and stays on /login", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, TEST_EMAIL, `${TEST_PASSWORD}-wrong`);

    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    expect(pathnameOf(page)).toBe("/login");
    // The password never reached the address bar (what a form submitted before hydration would do) ...
    expect(new URL(page.url()).search).toBe("");
    // ... the dashboard did not open ...
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
    // ... the form is usable again (the button left "Signing in...") and no session was made.
    await expect(page.getByTestId(ID.loginSubmit)).toHaveText("Sign In");
    await expect(page.getByTestId(ID.loginSubmit)).toBeEnabled();
    expect((await page.context().cookies()).some((cookie) => /session-token/.test(cookie.name))).toBe(false);
  });

  test("an unknown e-mail gets the same message as a wrong password", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, `${unique("nobody-")}@example.com`, TEST_PASSWORD);

    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    expect(pathnameOf(page)).toBe("/login");
  });

  test("a failed login can be corrected: the right password then signs in", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, TEST_EMAIL, "not-the-password");
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    // The address is still in its field (the user mistyped the password): only the password is typed again.
    await expect(page.getByTestId(ID.loginEmail)).toHaveValue(TEST_EMAIL);

    await page.getByTestId(ID.loginPassword).fill(TEST_PASSWORD);
    await page.getByTestId(ID.loginSubmit).click();

    await expectLandedOnSchemas(page);
    await expect(page.getByTestId(ID.topbar)).toBeVisible();
  });

  test("submitting an empty form is stopped by the form: no request, no error banner, still on /login", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    const authRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/")) authRequests.push(request.url());
    });

    await page.getByTestId(ID.loginSubmit).click();

    // Both required fields are flagged invalid by the browser, and the submit handler never ran.
    await expect(page.locator('[data-testid="login-email"]:invalid')).toHaveCount(1);
    await expect(page.locator('[data-testid="login-password"]:invalid')).toHaveCount(1);
    await expect(page.getByTestId(ID.loginError)).toHaveCount(0);
    expect(pathnameOf(page)).toBe("/login");
    expect(new URL(page.url()).search).toBe("");
    expect(authRequests, "an empty form must not call the auth API").toEqual([]);

    // An e-mail that is not an address is stopped the same way.
    await page.getByTestId(ID.loginEmail).fill("not-an-address");
    await page.getByTestId(ID.loginPassword).fill(TEST_PASSWORD);
    await page.getByTestId(ID.loginSubmit).click();
    await expect(page.locator('[data-testid="login-email"]:invalid')).toHaveCount(1);
    await expect(page.getByTestId(ID.loginError)).toHaveCount(0);
    expect(authRequests).toEqual([]);
  });

  test("the password field can be shown and hidden", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    const password = page.getByTestId(ID.loginPassword);
    const toggle = page.getByTestId(ID.loginToggle);

    await password.fill(TEST_PASSWORD);
    await expect(password).toHaveAttribute("type", "password");
    await expect(toggle).toHaveAccessibleName("Show password");

    await toggle.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(password).toHaveValue(TEST_PASSWORD);
    await expect(toggle).toHaveAccessibleName("Hide password");

    await toggle.click();
    await expect(password).toHaveAttribute("type", "password");
    await expect(toggle).toHaveAccessibleName("Show password");
  });

  test("'Create one' leads to the register page, and 'Sign in' leads back", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await page.getByTestId(ID.registerLink).click();
    await expect(page).toHaveURL((url) => url.pathname === "/register");
    await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();

    await page.getByTestId(ID.registerLoginLink).click();
    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });
});

test.describe("a visitor without a session", () => {
  test("is redirected from /schemas to /login", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    await page.goto("/schemas");

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect(page.getByTestId(ID.topbar), "the dashboard must not render for a visitor").toHaveCount(0);
  });

  test("is redirected from a deep entity URL to /login", { tag: ["@regression"] }, async ({ page }) => {
    await page.goto(`/schemas/${unique("no-domain-")}/${unique("no-product-")}/${unique("NoEntity")}`);

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect(page.getByTestId("dashboard-not-found"), "the 404 page must not be served to a visitor").toHaveCount(0);
  });

  test("is redirected from /admin to /login", { tag: ["@regression"] }, async ({ page }) => {
    await page.goto("/admin");

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
  });

  test("lands on /schemas after login, not on the page that was asked for (the login page does not use callbackUrl yet)", { tag: ["@regression"] }, async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page).toHaveURL((url) => url.pathname === "/login");
    // What the redirect carries: where the visitor was going.
    expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe("/admin/settings");
    await waitForHydration(page.getByTestId(ID.loginForm));

    await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);

    await expectLandedOnSchemas(page);
    await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  });
});

test.describe("a visitor with a forged or stale session cookie", () => {
  /** What a hand-made cookie looks like to the middleware, which only checks that one of these names is present. */
  const FORGED = "forged.not-a-valid-jwt.value";
  const COOKIE_NAMES = ["authjs.session-token", "next-auth.session-token"] as const;

  for (const name of COOKIE_NAMES) {
    test(`${name}=<garbage> does not open the dashboard: no data is served and the visitor ends on /login`, { tag: ["@regression"] }, async ({
      page,
      request,
      baseURL,
    }) => {
      // The server's answer, without following redirects: nothing of the dashboard (the system domains of the seed) in any answer.
      const raw = await request.get("/schemas", { headers: { cookie: `${name}=${FORGED}` }, maxRedirects: 0 });
      const body = await raw.text();
      expect(body, `a forged ${name} got dashboard data (HTTP ${raw.status()})`).not.toMatch(/Playground|Shared domain for general-purpose/);
      expect(raw.status(), "a forged cookie must be answered with a redirect to the login").toBeGreaterThanOrEqual(300);
      expect(raw.status()).toBeLessThan(400);

      // The browser: it ends on /login with the form (not on a redirect loop, not on the dashboard), and no dashboard is on screen.
      await page.context().addCookies([{ name, value: FORGED, url: baseURL! }]);
      await page.goto("/schemas");
      await expect(page).toHaveURL((url) => url.pathname === "/login");
      await expect(page.getByTestId(ID.loginForm)).toBeVisible();
      await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
      await expect(page.getByText("Playground")).toHaveCount(0);
    });
  }

  test("the app's own JSON endpoints answer 401 without a valid session, and the explorer's data is not served", { tag: ["@regression"] }, async ({
    request,
  }) => {
    const requests: Array<Record<string, string>> = [{}, { cookie: `authjs.session-token=${FORGED}` }, { cookie: `next-auth.session-token=${FORGED}` }];
    for (const headers of requests) {
      const tree = await request.get("/api/domains-tree", { headers, maxRedirects: 0 });
      expect(tree.status(), `/api/domains-tree with ${JSON.stringify(headers)}`).toBe(401);
      expect(await tree.text()).not.toMatch(/Playground|Public/);
      const tenants = await request.get("/api/tenants", { headers, maxRedirects: 0 });
      expect(tenants.status(), `/api/tenants with ${JSON.stringify(headers)}`).toBe(401);
    }
    // What stays public on purpose: the health probe.
    expect((await request.get("/api/v1/health", { maxRedirects: 0 })).status()).toBe(200);
  });
});

test.describe("sign out", () => {
  test("the user menu's Sign Out returns to /login, and the dashboard is closed again", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);
    await expectLandedOnSchemas(page);
    await expectSignedInAs(page, TEST_EMAIL);

    await page.getByTestId(ID.userMenu).click();
    await page.getByTestId(ID.signOut).click();

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect
      .poll(async () => (await page.context().cookies()).some((cookie) => /session-token/.test(cookie.name)), {
        message: "the session cookie is still there after signing out",
      })
      .toBe(false);

    // A direct visit is refused now.
    await page.goto("/schemas");
    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
  });
});

test.describe("a signed-in visitor", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("on /login or /register is sent to /schemas", { tag: ["@regression"] }, async ({ page }) => {
    for (const path of ["/login", "/register"]) {
      await page.goto(path);
      await expect(page, `${path} did not redirect a signed-in visitor`).toHaveURL((url) => url.pathname === "/schemas");
      await expect(page.getByTestId(ID.topbar)).toBeVisible();
    }
  });
});

test.describe("register", () => {
  test("creates the account, signs the new user in and lands on /schemas", { tag: ["@regression"] }, async ({ page }) => {
    const email = `${unique("e2e-register-")}@example.com`.toLowerCase();
    registeredEmails.push(email);

    await openRegister(page);
    await fillRegister(page, email, REGISTER_PASSWORD);
    await expect(page.getByText("Passwords match")).toBeVisible();
    await page.getByTestId(ID.registerSubmit).click();

    await expectLandedOnSchemas(page, 60_000);
    await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    await expectSignedInAs(page, email);
  });

  test("an account that exists already is refused with a message at the e-mail field", { tag: ["@regression"] }, async ({ page }) => {
    await openRegister(page);
    // The seeded admin has an account: registering its address must not create a second one (nor change its password).
    await fillRegister(page, TEST_EMAIL, REGISTER_PASSWORD);
    await page.getByTestId(ID.registerSubmit).click();

    await expect(page.getByTestId(ID.registerEmailError)).toHaveText("An account with this email already exists");
    expect(pathnameOf(page)).toBe("/register");
    await expect(page.getByTestId(ID.registerEmail)).toHaveValue(TEST_EMAIL);
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
  });

  test("a second registration with the same e-mail is refused after the first one worked", { tag: ["@regression"] }, async ({ page }) => {
    const email = `${unique("e2e-twice-")}@example.com`.toLowerCase();
    registeredEmails.push(email);

    await openRegister(page);
    await fillRegister(page, email, REGISTER_PASSWORD);
    await page.getByTestId(ID.registerSubmit).click();
    await expectLandedOnSchemas(page, 60_000);
    await expect(page.getByTestId(ID.topbar)).toBeVisible();

    // Back to a visitor, then the same address again.
    await page.getByTestId(ID.userMenu).click();
    await page.getByTestId(ID.signOut).click();
    await expect(page).toHaveURL((url) => url.pathname === "/login");

    await openRegister(page);
    await fillRegister(page, email, REGISTER_PASSWORD);
    await page.getByTestId(ID.registerSubmit).click();

    await expect(page.getByTestId(ID.registerEmailError)).toHaveText("An account with this email already exists");
    expect(pathnameOf(page)).toBe("/register");
  });

  test("a confirmation that differs is refused with a message at the confirmation field, and no account is made", { tag: ["@regression"] }, async ({ page }) => {
    const email = `${unique("e2e-mismatch-")}@example.com`.toLowerCase();
    registeredEmails.push(email);

    await openRegister(page);
    await fillRegister(page, email, REGISTER_PASSWORD, `${REGISTER_PASSWORD}x`);
    // Live feedback while typing ...
    await expect(page.getByText("Passwords do not match")).toBeVisible();
    await page.getByTestId(ID.registerSubmit).click();

    // ... and the server's answer on submit.
    await expect(page.getByTestId(ID.registerConfirmError)).toHaveText("Passwords do not match");
    expect(pathnameOf(page)).toBe("/register");
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
    // What the user typed is still there: the address (an uncontrolled field is emptied when the form's action answers) and the password.
    await expect(page.getByTestId(ID.registerEmail)).toHaveValue(email);
    await expect(page.getByTestId(ID.registerPassword)).toHaveValue(REGISTER_PASSWORD);

    // Only the confirmation is typed again, and the account is made.
    await page.getByTestId(ID.registerConfirm).fill(REGISTER_PASSWORD);
    await page.getByTestId(ID.registerSubmit).click();
    await expectLandedOnSchemas(page, 60_000);
  });

  test("both password fields can be shown and hidden", { tag: ["@regression"] }, async ({ page }) => {
    await openRegister(page);
    await fillRegister(page, `${unique("e2e-toggle-")}@example.com`, REGISTER_PASSWORD);

    const password = page.getByTestId(ID.registerPassword);
    const confirmation = page.getByTestId(ID.registerConfirm);
    await expect(password).toHaveAttribute("type", "password");
    await expect(confirmation).toHaveAttribute("type", "password");

    await page.getByTestId(ID.registerToggle).click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(confirmation, "the first toggle must not reveal the confirmation").toHaveAttribute("type", "password");

    await page.getByTestId(ID.registerConfirmToggle).click();
    await expect(confirmation).toHaveAttribute("type", "text");
    await expect(confirmation).toHaveValue(REGISTER_PASSWORD);

    await page.getByTestId(ID.registerToggle).click();
    await page.getByTestId(ID.registerConfirmToggle).click();
    await expect(password).toHaveAttribute("type", "password");
    await expect(confirmation).toHaveAttribute("type", "password");
  });
});
