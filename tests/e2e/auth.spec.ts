/**
 * Authentication, through the real login and register pages and the user menu.
 *
 * Every test here starts logged OUT (`test.use({ storageState: ... })` below replaces the admin session the `setup` project saved), so
 * the tests use `page`, never `authedPage`. A test that needs a session of its own logs in through the form in its own browser
 * context; the JWT session of Auth.js is stateless, so signing one out cannot end the admin session the other specs use.
 *
 * What the app does (each line is a test):
 *   - the middleware sends a visitor without a VALID session to `/login?callbackUrl=<the page asked for>`, and the login form returns
 *     there after signing in, only when that is a path of this site (`//evil.com`, `https://evil.com` go to `/schemas`);
 *   - a cookie with a session's NAME is not a session (forged `authjs.session-token` / `next-auth.session-token`): no dashboard, no
 *     data, no redirect loop; the app's own JSON endpoints answer 401;
 *   - a signed-in visitor on /login or /register is sent to `/schemas`;
 *   - registration is OPEN for the app under test (`AUTH_REGISTRATION=open`, scripts/e2e-env.mjs; the default is `invite`, which the unit tests of the
 *     register action cover). Registering makes a ROLELESS account and answers the same for an address that exists as for a new one, with the same
 *     redirect to /login: nobody is signed in by registering, and a roleless user who signs in lands on /no-access, not the dashboard;
 *   - too many wrong passwords for one e-mail lock it, and the lock is answered with the same message as a wrong password;
 *   - an invitation link and a password-reset link work once, for a live token, and say one thing for every dead one (the rows are made through the database:
 *     there is no e-mail to read a link from);
 *   - the login page offers NO identity-provider button and Auth.js lists the credentials provider only (AUTH_PROVIDERS is blank in a run), and a refusal that comes
 *     back from a provider (`?error=...`) is worded like a wrong password;
 *   - a login form submitted before React hydrated it never puts the password in the address (its HTML says method="post" and its
 *     button is disabled until the page is interactive);
 *   - fields have labels (the specs find them with getByLabel), a refusal is announced and moves the focus to the field to fix.
 *
 * The specs wait for a client form's hydration before they type (`waitForHydration`), because that is what a user cannot beat.
 */
import type { Page } from "@playwright/test";
import { AUTH_STATE_PATH, TEST_EMAIL, TEST_PASSWORD } from "./helpers/auth-state";
import {
  activeTenantId,
  createInvitationRow,
  createResetTokenRow,
  createUserWithPassword,
  deleteInvitationsByEmail,
  deleteUsersByEmail,
  disconnectDb,
  pg,
  seededOwnerId,
} from "./helpers/db";
import { test, expect, unique } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";

test.use({ storageState: { cookies: [], origins: [] } });

/** Test ids of the login and register pages (src/app/(auth)) and of the user menu (src/components/layout/TopBar.tsx). */
const ID = {
  loginForm: "login-form",
  loginEmail: "login-email",
  loginSubmit: "login-submit",
  loginError: "login-error",
  loginToggle: "login-password-toggle",
  registerLink: "login-register-link",
  registerForm: "register-form",
  registerSubmit: "register-submit",
  registerToggle: "register-password-toggle",
  registerConfirmToggle: "register-confirm-password-toggle",
  registerConfirmError: "register-confirm-password-error",
  registerLoginLink: "register-login-link",
  userMenu: "user-menu",
  userEmail: "user-email",
  signOut: "sign-out",
  topbar: "topbar",
  loginNotice: "login-notice",
  noAccess: "no-access",
  noAccessEmail: "no-access-email",
  noAccessSignOut: "no-access-sign-out",
  inviteForm: "invite-form",
  inviteEmail: "invite-email",
  inviteSubmit: "invite-submit",
  resetForm: "reset-form",
  resetSubmit: "reset-submit",
  invalidLink: "invalid-link",
  providerButtons: "provider-buttons",
} as const;

const INVALID_CREDENTIALS = "Invalid email or password";
const INVALID_LINK = "This link is not valid or has expired.";
const REGISTER_PASSWORD = "Str0ng!Passw0rd";
/** What the sign-in page says after /register, for a new address and for one that already has an account alike (src/lib/auth/messages.ts). */
const REGISTERED_NOTICE = /If this address was not registered before, your account is ready/;

/** Registered by a test through the UI (or made by its fixtures); removed afterwards so the admin's user list does not grow with every run. */
const registeredEmails: string[] = [];
/** Addresses a test made an invitation for (an accepted invitation stays in its table; removed afterwards like the users). */
const invitedEmails: string[] = [];

test.afterAll(async () => {
  try {
    await deleteUsersByEmail(registeredEmails);
    await deleteInvitationsByEmail(invitedEmails);
  } catch (error) {
    console.warn(`auth.spec cleanup failed for ${registeredEmails.join(", ")}: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

// The fields, found the way a person (or a screen reader) finds them: by their label.
// (`exact`: a label query is a substring match by default, and the show/hide buttons are labelled "Show password" / "Show confirm password".)
const emailField = (page: Page) => page.getByLabel("Email", { exact: true });
const passwordField = (page: Page) => page.getByLabel("Password", { exact: true });
const confirmField = (page: Page) => page.getByLabel("Confirm Password", { exact: true });

async function openLogin(page: Page, search = ""): Promise<void> {
  await page.goto(`/login${search}`);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await waitForHydration(page.getByTestId(ID.loginForm));
}

async function openRegister(page: Page): Promise<void> {
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
  await waitForHydration(page.getByTestId(ID.registerForm));
}

async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await emailField(page).fill(email);
  await passwordField(page).fill(password);
  await page.getByTestId(ID.loginSubmit).click();
}

async function fillRegister(page: Page, email: string, password: string, confirmation = password): Promise<void> {
  await emailField(page).fill(email);
  await passwordField(page).fill(password);
  await confirmField(page).fill(confirmation);
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
const hasSessionCookie = async (page: Page): Promise<boolean> => (await page.context().cookies()).some((cookie) => /session-token/.test(cookie.name));

/**
 * Signing in ends with a navigation to the page asked for, which renders it for the first time in that browser context (and the server
 * checks a password first): longer than an assertion's usual wait. Registering also hashes the password with bcrypt (12 rounds) first.
 */
async function expectLandedAt(page: Page, path: string, timeout = 30_000): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === path, { timeout });
}
const expectLandedOnSchemas = (page: Page, timeout?: number) => expectLandedAt(page, "/schemas", timeout);

/** A navigation or a request of the page that carries the password in its address: the thing a form submitted before hydration would do. */
function watchForPasswordInAddress(page: Page, password: string): string[] {
  const leaks: string[] = [];
  const check = (url: string) => {
    if (url.includes(encodeURIComponent(password)) || url.includes(password)) leaks.push(url);
  };
  page.on("framenavigated", (frame) => check(frame.url()));
  page.on("request", (request) => check(request.url()));
  return leaks;
}

test.describe("login", () => {
  test("a valid login lands on /schemas, signed in as that user", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);

    await expectLandedOnSchemas(page);
    await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    await expectSignedInAs(page, TEST_EMAIL);
    expect(await hasSessionCookie(page), "login did not set a session cookie").toBe(true);
  });

  test("a wrong password shows 'Invalid email or password' and stays on /login", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    const wrong = `${TEST_PASSWORD}-wrong`;
    await openLogin(page);
    const leaks = watchForPasswordInAddress(page, wrong);
    await submitLogin(page, TEST_EMAIL, wrong);

    // Announced (role=alert), and the user is where the fix is: the focus is in the e-mail field, which still holds the address.
    await expect(page.getByRole("alert").filter({ hasText: INVALID_CREDENTIALS })).toBeVisible();
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    await expect(emailField(page)).toBeFocused();
    await expect(emailField(page)).toHaveValue(TEST_EMAIL);
    expect(pathnameOf(page)).toBe("/login");
    // The password never reached the address bar (what a form submitted before hydration would do) and is not in the field any more ...
    expect(new URL(page.url()).search).toBe("");
    expect(leaks, "the password was in the address of a navigation or a request").toEqual([]);
    await expect(passwordField(page)).toHaveValue("");
    // ... the dashboard did not open, the form is usable again (the button left "Signing in...") and no session was made.
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
    await expect(page.getByTestId(ID.loginSubmit)).toHaveText("Sign In");
    await expect(page.getByTestId(ID.loginSubmit)).toBeEnabled();
    expect(await hasSessionCookie(page)).toBe(false);
  });

  test("an unknown e-mail gets the same message as a wrong password", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, `${unique("nobody-")}@example.com`, TEST_PASSWORD);

    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    expect(pathnameOf(page)).toBe("/login");
  });

  test("a failed login can be corrected: only the password is typed again, and it signs in", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, TEST_EMAIL, "not-the-password");
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    // The address is still in its field (the user mistyped the password); the password is not.
    await expect(emailField(page)).toHaveValue(TEST_EMAIL);
    await expect(passwordField(page)).toHaveValue("");

    await passwordField(page).fill(TEST_PASSWORD);
    await page.getByTestId(ID.loginSubmit).click();

    await expectLandedOnSchemas(page);
    await expect(page.getByTestId(ID.topbar)).toBeVisible();
  });

  test("values put into the fields without a change event (autofill) are what is sent", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    // What a browser's autofill or a password manager can do: set the value without telling the page's handlers.
    const setSilently = (element: HTMLElement, value: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    await emailField(page).evaluate(setSilently, TEST_EMAIL);
    await passwordField(page).evaluate(setSilently, TEST_PASSWORD);
    await page.getByTestId(ID.loginSubmit).click();

    await expectLandedOnSchemas(page);
    await expectSignedInAs(page, TEST_EMAIL);
  });

  test("submitting an empty form is stopped by the browser: the e-mail field is focused and invalid, nothing is sent, no banner", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    const authRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/")) authRequests.push(request.url());
    });

    await page.getByTestId(ID.loginSubmit).click();

    // The positive signal that the BROWSER blocked the submit: it moved the focus to the first invalid field, which carries a message.
    await expect(emailField(page)).toBeFocused();
    expect(await emailField(page).evaluate((el) => (el as HTMLInputElement).validationMessage), "no validation message on the e-mail field").not.toBe("");
    expect(await emailField(page).evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    expect(await passwordField(page).evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    await expect(page.locator('[data-testid="login-email"]:invalid')).toHaveCount(1);
    // ... and so nothing happened: no banner, the same address, no call of the auth API.
    await expect(page.getByTestId(ID.loginError)).toHaveCount(0);
    expect(pathnameOf(page)).toBe("/login");
    expect(new URL(page.url()).search).toBe("");
    expect(authRequests, "an empty form must not call the auth API").toEqual([]);

    // An e-mail that is not an address is stopped the same way: its field has a message of its own (a type mismatch, not a missing value).
    await emailField(page).fill("not-an-address");
    await passwordField(page).fill(TEST_PASSWORD);
    await page.getByTestId(ID.loginSubmit).click();
    await expect(emailField(page)).toBeFocused();
    expect(await emailField(page).evaluate((el) => (el as HTMLInputElement).validity.typeMismatch)).toBe(true);
    expect(await emailField(page).evaluate((el) => (el as HTMLInputElement).validationMessage)).not.toBe("");
    await expect(page.getByTestId(ID.loginError)).toHaveCount(0);
    expect(authRequests).toEqual([]);
  });

  test("every field has a label it is tied to: getByLabel finds the e-mail and the password", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await expect(emailField(page)).toHaveAttribute("name", "email");
    await expect(passwordField(page)).toHaveAttribute("name", "password");
    await expect(passwordField(page)).toHaveAccessibleName("Password");
  });

  test("the password field can be shown and hidden", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    const toggle = page.getByTestId(ID.loginToggle);

    await passwordField(page).fill(TEST_PASSWORD);
    await expect(passwordField(page)).toHaveAttribute("type", "password");
    await expect(toggle).toHaveAccessibleName("Show password");

    await toggle.click();
    await expect(passwordField(page)).toHaveAttribute("type", "text");
    await expect(passwordField(page)).toHaveValue(TEST_PASSWORD);
    await expect(toggle).toHaveAccessibleName("Hide password");

    await toggle.click();
    await expect(passwordField(page)).toHaveAttribute("type", "password");
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

  test("offers NO identity-provider button by default: the password form alone, and the app lists the credentials provider only", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page);
    await expect(page.getByTestId(ID.providerButtons)).toHaveCount(0);
    await expect(page.getByText(/or continue with email/i)).toHaveCount(0);
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();

    // Auth.js lists what it is configured with (src/lib/auth/providers.ts: AUTH_PROVIDERS is blank in a run, scripts/e2e-env.mjs): nothing but the local accounts.
    const response = await page.request.get("/api/auth/providers");
    expect(response.ok()).toBe(true);
    expect(Object.keys(await response.json())).toEqual(["credentials"]);
  });

  test("an identity provider's refusal (/login?error=AccessDenied) comes back as the words of a wrong password and nothing else", { tag: ["@regression"] }, async ({ page }) => {
    await openLogin(page, "?error=AccessDenied");
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    await expect(page.locator("body")).not.toContainText("AccessDenied");
    expect(pathnameOf(page)).toBe("/login");
  });
});

test.describe("a form that is submitted before the page is interactive", () => {
  test("the server's HTML of both forms cannot put a password in the address: login posts and its button is disabled, register posts", { tag: ["@regression"] }, async ({
    request,
  }) => {
    const tagOf = (html: string, testId: string) => new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";

    const login = await (await request.get("/login")).text();
    expect(tagOf(login, ID.loginForm), "the login form is not in the server's HTML").toMatch(/\smethod="post"/i);
    expect(tagOf(login, ID.loginSubmit)).toMatch(/\sdisabled(=""|\s|>)/);

    const register = await (await request.get("/register")).text();
    // A server-action form: React writes method="POST" (and the action's id) into the HTML, so it works before hydration, as a POST.
    expect(tagOf(register, ID.registerForm), "the register form is not in the server's HTML").toMatch(/\smethod="post"/i);
  });

  test("with the page's scripts blocked, Enter in the login fields sends nothing: no request carries the password", { tag: ["@regression"] }, async ({ page }) => {
    await page.route("**/_next/static/**/*.js", (route) => route.abort());
    await page.goto("/login");
    const typed = unique("not-a-real-password-");
    const leaks = watchForPasswordInAddress(page, typed);

    await emailField(page).fill(TEST_EMAIL);
    await passwordField(page).fill(typed);
    // Without React the button is still disabled: the browser does not submit a form whose default button is disabled.
    await expect(page.getByTestId(ID.loginSubmit)).toBeDisabled();
    await passwordField(page).press("Enter");
    // Two frames: a native submission would have been started by now.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    expect(pathnameOf(page)).toBe("/login");
    expect(new URL(page.url()).search).toBe("");
    expect(leaks, "the password was sent in an address").toEqual([]);
  });
});

test.describe("a visitor without a session", () => {
  test("is redirected from /schemas to /login, which remembers the page asked for", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    await page.goto("/schemas");

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe("/schemas");
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect(page.getByTestId(ID.topbar), "the dashboard must not render for a visitor").toHaveCount(0);
  });

  test("is redirected from a deep entity URL to /login, with the whole path in callbackUrl", { tag: ["@regression"] }, async ({ page }) => {
    const deep = `/schemas/${unique("no-domain-")}/${unique("no-product-")}/${unique("NoEntity")}`;
    await page.goto(deep);

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe(deep);
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect(page.getByTestId("dashboard-not-found"), "the 404 page must not be served to a visitor").toHaveCount(0);
  });

  test("is redirected from /admin to /login", { tag: ["@regression"] }, async ({ page }) => {
    await page.goto("/admin");

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe("/admin");
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
  });

  test("returns to the page that was asked for after login (path and query)", { tag: ["@regression"] }, async ({ page }) => {
    await page.goto("/schemas/type-mappings?from=login-spec");
    await expect(page).toHaveURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe("/schemas/type-mappings?from=login-spec");
    await waitForHydration(page.getByTestId(ID.loginForm));

    await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);

    await expectLandedAt(page, "/schemas/type-mappings");
    expect(new URL(page.url()).search).toBe("?from=login-spec");
    await expect(page.getByRole("heading", { name: "Type Mapping Reference" })).toBeVisible();
    await expectSignedInAs(page, TEST_EMAIL);
  });

  for (const [name, callbackUrl] of [
    ["a protocol-relative URL", "//evil.example.com/schemas"],
    ["an absolute URL", "https://evil.example.com/"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a backslash host", "/\\evil.example.com"],
    ["the login page itself (a loop)", "/login?callbackUrl=/admin"],
  ] as const) {
    test(`ignores a callbackUrl that is ${name}: lands on /schemas of this site`, { tag: ["@regression"] }, async ({ page, baseURL }) => {
      await openLogin(page, `?callbackUrl=${encodeURIComponent(callbackUrl)}`);

      await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);

      await expectLandedOnSchemas(page);
      expect(new URL(page.url()).origin, "left this site").toBe(new URL(baseURL!).origin);
      await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    });
  }
});

test.describe("a visitor with a forged or stale session cookie", () => {
  /** What a hand-made cookie looks like to the middleware: the right name, a value that is no token. */
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

  test("a server action from a page whose session has gone gets a 401, not a redirect the browser would POST again", { tag: ["@regression"] }, async ({
    request,
  }) => {
    const withActionHeader: Array<Record<string, string>> = [{ "next-action": "40abc" }, { "next-action": "40abc", cookie: `authjs.session-token=${FORGED}` }];
    for (const headers of withActionHeader) {
      const response = await request.post("/schemas", { headers, maxRedirects: 0, data: "[]" });
      expect(response.status(), JSON.stringify(headers)).toBe(401);
      expect(response.headers()["location"]).toBeUndefined();
      expect(await response.json()).toEqual({ error: "Not authenticated" });
    }
  });

  test("a server action POSTed to a page address that ends like an image (/schemas/foo.png) still meets the middleware: 401, never executed", { tag: ["@regression"] }, async ({
    request,
  }) => {
    // The matcher used to leave out static files by the look of the address (`.png`); `/schemas/foo.png` is a page (`[domainSlug]`),
    // and an action POSTed there skipped the door. Now only a GET / HEAD of a listed public asset (the favicon) does.
    for (const path of ["/schemas/foo.png", "/schemas/billing/foo.svg", "/schemas/a/b/c.jpg"]) {
      for (const cookie of [undefined, `authjs.session-token=${FORGED}`]) {
        const response = await request.post(path, {
          headers: { "next-action": "x", ...(cookie ? { cookie } : {}) },
          maxRedirects: 0,
          data: "[]",
        });
        expect(response.status(), `${path} with ${cookie ?? "no cookie"}`).toBe(401);
        expect(await response.json(), path).toEqual({ error: "Not authenticated" });
      }
    }
  });

  test("a progressive-enhancement form action (a multipart POST that names the action in its body, no Next-Action header) to /schemas/foo.png is refused too", { tag: ["@regression"] }, async ({
    request,
  }) => {
    for (const path of ["/schemas/foo.png", "/schemas/billing/foo.svg", "/schemas/foo.PNG"]) {
      for (const cookie of [undefined, `authjs.session-token=${FORGED}`]) {
        const response = await request.post(path, {
          headers: cookie ? { cookie } : {},
          multipart: { "$ACTION_ID_40abc": "" },
          maxRedirects: 0,
        });
        // Sent to the login page: not served, not executed.
        expect(response.status(), `${path} with ${cookie ?? "no cookie"}`).toBe(307);
        expect(new URL(response.headers()["location"], "http://localhost").pathname).toBe("/login");
      }
    }
  });

  test("a GET of a page address that ends like an image (/schemas/foo.png) meets the door: no session, no page; the favicon is public", { tag: ["@regression"] }, async ({
    request,
  }) => {
    for (const path of ["/schemas/foo.png", "/schemas/billing/foo.svg", "/schemas/a/b/c.jpg", "/schemas/foo.PNG"]) {
      for (const cookie of [undefined, `authjs.session-token=${FORGED}`]) {
        const response = await request.get(path, { headers: cookie ? { cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
        expect(response.status(), `${path} with ${cookie ?? "no cookie"}`).toBe(307);
        expect(new URL(response.headers()["location"], "http://localhost").pathname).toBe("/login");
      }
    }
    // The one listed public asset is served without a session (it is what the login page's tab shows).
    const favicon = await request.get("/favicon.ico", { maxRedirects: 0, failOnStatusCode: false });
    expect(favicon.status()).toBe(200);
    expect(favicon.headers()["content-type"]).toMatch(/image\//);
  });

  test("odd spellings of the endpoint's address (//api, /API, an encoded letter, an encoded slash under /login) serve no data without a session", { tag: ["@regression"] }, async ({
    request,
  }) => {
    for (const path of ["//api/domains-tree", "/API/domains-tree", "/%61pi/domains-tree", "/api/domains-tree/", "/login%2F..%2Fapi%2Fdomains-tree"]) {
      const response = await request.get(path, { maxRedirects: 0, failOnStatusCode: false });
      expect(response.status(), `${path} answered ${response.status()}`).not.toBe(200);
      expect(await response.text(), `${path} served the explorer's data`).not.toMatch(/Playground|"domains"/);
    }
  });
});

test.describe("sign out", () => {
  test("the user menu's Sign Out returns to /login, and the dashboard is closed again", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);
    await expectLandedOnSchemas(page);
    await expectSignedInAs(page, TEST_EMAIL);

    await page.getByTestId(ID.userMenu).click();
    await page.getByTestId(ID.signOut).click();

    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByTestId(ID.loginForm)).toBeVisible();
    await expect.poll(() => hasSessionCookie(page), { message: "the session cookie is still there after signing out" }).toBe(false);

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
  test("makes a ROLELESS account: registering signs nobody in, the user is sent to /login, and signing in lands on /no-access, not the dashboard", { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    const email = `${unique("e2e-register-")}@example.com`.toLowerCase();
    registeredEmails.push(email);

    await openRegister(page);
    await fillRegister(page, email, REGISTER_PASSWORD);
    await expect(page.getByText("Passwords match")).toBeVisible();
    await page.getByTestId(ID.registerSubmit).click();

    // Nobody is signed in by registering (that could only be done for a NEW address, which would tell a visitor which addresses have accounts):
    // the visitor is sent to the login page, with a notice that is the same for a new and an existing address.
    await expectLandedAt(page, "/login", 60_000);
    await expect(page.getByTestId(ID.loginNotice)).toContainText(REGISTERED_NOTICE);
    expect(await hasSessionCookie(page), "registering must not sign the user in").toBe(false);
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);

    // Signing in with the password just chosen works, and the account holds no role: the "no access yet" screen, not the dashboard.
    await waitForHydration(page.getByTestId(ID.loginForm));
    await submitLogin(page, email, REGISTER_PASSWORD);
    await expectLandedAt(page, "/no-access");
    await expect(page.getByRole("heading", { name: "No access yet" })).toBeVisible();
    await expect(page.getByTestId(ID.noAccessEmail)).toContainText(email);
    await expect(page.getByTestId(ID.topbar), "a roleless user must not get the dashboard").toHaveCount(0);

    // The dashboard sends the roleless user straight back, and nothing of it renders.
    await page.goto("/schemas");
    await expectLandedAt(page, "/no-access");
    await expect(page.getByText("Playground")).toHaveCount(0);

    // The way out works.
    await page.getByTestId(ID.noAccessSignOut).click();
    await expectLandedAt(page, "/login");
    await expect.poll(() => hasSessionCookie(page), { message: "the session cookie is still there after signing out from /no-access" }).toBe(false);
  });

  test("every field has a label it is tied to: getByLabel finds the e-mail, the password and its confirmation", { tag: ["@regression"] }, async ({ page }) => {
    await openRegister(page);
    await expect(emailField(page)).toHaveAttribute("name", "email");
    await expect(passwordField(page)).toHaveAttribute("name", "password");
    await expect(confirmField(page)).toHaveAttribute("name", "confirmPassword");
  });

  test("an address that has an account is answered EXACTLY like a new one (no way to find out who has an account), and its password is not changed", { tag: ["@regression"] }, async ({
    page,
  }) => {
    await openRegister(page);
    // The seeded admin has an account: registering its address answers like a new address (the same redirect, the same notice), makes no second
    // account, and does not change the password.
    await fillRegister(page, TEST_EMAIL, REGISTER_PASSWORD);
    await page.getByTestId(ID.registerSubmit).click();

    await expectLandedAt(page, "/login", 60_000);
    await expect(page.getByTestId(ID.loginNotice)).toContainText(REGISTERED_NOTICE);
    expect(await hasSessionCookie(page)).toBe(false);
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);

    // The account is as it was: its own password still signs in (and the one that was tried does not).
    await waitForHydration(page.getByTestId(ID.loginForm));
    await submitLogin(page, TEST_EMAIL, REGISTER_PASSWORD);
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    await passwordField(page).fill(TEST_PASSWORD);
    await page.getByTestId(ID.loginSubmit).click();
    await expectLandedOnSchemas(page);
  });

  test("a second registration with the same e-mail is answered like the first, and does not replace the account (nor its password)", { tag: ["@regression"] }, async ({ page }) => {
    const email = `${unique("e2e-twice-")}@example.com`.toLowerCase();
    const second = "Another!Passw0rd-2";
    registeredEmails.push(email);

    await openRegister(page);
    await fillRegister(page, email, REGISTER_PASSWORD);
    await page.getByTestId(ID.registerSubmit).click();
    await expectLandedAt(page, "/login", 60_000);
    const firstNotice = await page.getByTestId(ID.loginNotice).innerText();

    // The same address again, with another password.
    await openRegister(page);
    await fillRegister(page, email, second);
    await page.getByTestId(ID.registerSubmit).click();
    await expectLandedAt(page, "/login", 60_000);
    expect(await page.getByTestId(ID.loginNotice).innerText(), "the answer must not tell a new address from an existing one").toBe(firstNotice);

    // One account, with the FIRST password: the second one did not replace it.
    await waitForHydration(page.getByTestId(ID.loginForm));
    await submitLogin(page, email, second);
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    await passwordField(page).fill(REGISTER_PASSWORD);
    await page.getByTestId(ID.loginSubmit).click();
    await expectLandedAt(page, "/no-access");
  });

  test("a password the policy refuses is refused at the password field with its reason, and no account is made", { tag: ["@regression"] }, async ({ page }) => {
    const email = `${unique("e2e-weak-")}@example.com`.toLowerCase();
    registeredEmails.push(email);

    await openRegister(page);
    await fillRegister(page, email, "password1234");
    await page.getByTestId(ID.registerSubmit).click();

    await expect(page.getByTestId("register-password-error")).toContainText("too easy to guess");
    await expect(passwordField(page)).toBeFocused();
    expect(pathnameOf(page)).toBe("/register");
    await expect(emailField(page)).toHaveValue(email);
  });

  test("a confirmation that differs is refused at the confirmation field (focus there, typed values kept), and no account is made", { tag: ["@regression"] }, async ({
    page,
  }) => {
    const email = `${unique("e2e-mismatch-")}@example.com`.toLowerCase();
    registeredEmails.push(email);

    await openRegister(page);
    await fillRegister(page, email, REGISTER_PASSWORD, `${REGISTER_PASSWORD}x`);
    // Live feedback while typing ...
    await expect(page.getByText("Passwords do not match")).toBeVisible();
    await page.getByTestId(ID.registerSubmit).click();

    // ... and the server's answer on submit.
    await expect(page.getByTestId(ID.registerConfirmError)).toHaveText("Passwords do not match");
    await expect(confirmField(page)).toBeFocused();
    expect(pathnameOf(page)).toBe("/register");
    await expect(page.getByTestId(ID.topbar)).toHaveCount(0);
    // What the user typed is still there: the address (an uncontrolled field is emptied when the form's action answers) and the password.
    await expect(emailField(page)).toHaveValue(email);
    await expect(passwordField(page)).toHaveValue(REGISTER_PASSWORD);

    // Only the confirmation is typed again, and the account is made (the visitor goes to the login page: nobody is signed in by registering).
    await confirmField(page).fill(REGISTER_PASSWORD);
    await page.getByTestId(ID.registerSubmit).click();
    await expectLandedAt(page, "/login", 60_000);
    await expect(page.getByTestId(ID.loginNotice)).toContainText(REGISTERED_NOTICE);
  });

  test("both password fields can be shown and hidden", { tag: ["@regression"] }, async ({ page }) => {
    await openRegister(page);
    await fillRegister(page, `${unique("e2e-toggle-")}@example.com`, REGISTER_PASSWORD);

    const password = passwordField(page);
    const confirmation = confirmField(page);
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

test.describe("lockout", () => {
  test("five wrong passwords lock the e-mail, and even the RIGHT password is then refused with the same message (no way to tell a lock from a wrong password)", { tag: ["@regression"] }, async ({
    page,
  }) => {
    const email = `${unique("e2e-lock-")}@example.com`.toLowerCase();
    const password = "marble-window-harvest-77";
    await createUserWithPassword({ email, password });
    registeredEmails.push(email);

    await openLogin(page);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await submitLogin(page, email, `${password}-wrong-${attempt}`);
      await expect(page.getByTestId(ID.loginError), `wrong attempt ${attempt}`).toHaveText(INVALID_CREDENTIALS);
      await expect(page.getByTestId(ID.loginSubmit)).toBeEnabled();
    }

    // The sixth attempt carries the right password: it is refused, in the same words, and nothing says "locked" or "try again in N minutes".
    await submitLogin(page, email, password);
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    expect(pathnameOf(page)).toBe("/login");
    expect(await hasSessionCookie(page), "a locked e-mail must not get a session").toBe(false);
    await expect(page.getByText(/locked|too many|try again in|minutes/i)).toHaveCount(0);

    // The lock is that e-mail's: the seeded admin signs in from the same browser.
    await submitLogin(page, TEST_EMAIL, TEST_PASSWORD);
    await expectLandedOnSchemas(page);
  });
});

test.describe("invitation and reset links", () => {
  test("a link that is not a live token says ONE thing, in the open (no session needed), with no form", { tag: ["@regression"] }, async ({ page }) => {
    const unknown = "A".repeat(43);
    const texts: string[] = [];
    for (const path of ["/invite/garbage", `/invite/${unknown}`, "/reset/garbage", `/reset/${unknown}`]) {
      await page.goto(path);
      expect(pathnameOf(page), `${path} must be reachable without a session, not redirected to /login`).toBe(path);
      await expect(page.getByTestId(ID.invalidLink), path).toBeVisible();
      await expect(page.getByText(INVALID_LINK), path).toBeVisible();
      await expect(page.locator("form"), `${path} must not offer a form`).toHaveCount(0);
      texts.push(await page.getByTestId(ID.invalidLink).innerText());
    }
    expect(new Set(texts).size, "every dead link must read the same").toBe(1);
  });

  test("an invitation makes the account for the invited e-mail with the roles it carries, works once, and then says the same as any dead link", { tag: ["@regression"] }, async ({
    page,
  }) => {
    const email = `${unique("e2e-invitee-")}@example.com`.toLowerCase();
    const password = "tangerine-lantern-orbit-42";
    // Not in `registeredEmails`: accepting an invitation writes an audit entry for the new user, audit rows are immutable and point at their user, so
    // the account cannot be deleted (a DELETE of it fails and takes the others in its statement with it). The release run's database is thrown away.
    invitedEmails.push(email);
    const { token } = await createInvitationRow({ email, createdById: await seededOwnerId(), roles: [{ role: "VIEWER", scopeKey: `T:${await activeTenantId()}` }] });

    await page.goto(`/invite/${token}`);
    await waitForHydration(page.getByTestId(ID.inviteForm));
    // The invited address is shown and cannot be changed.
    await expect(page.getByTestId(ID.inviteEmail)).toHaveValue(email);
    await expect(page.getByTestId(ID.inviteEmail)).not.toBeEditable();
    // A weak password is refused with its reason and the link stays usable.
    await page.getByLabel("New password", { exact: true }).fill("password1234");
    await page.getByLabel("Confirm password", { exact: true }).fill("password1234");
    await page.getByTestId(ID.inviteSubmit).click();
    await expect(page.getByTestId("invite-password-error")).toContainText("too easy to guess");

    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password", { exact: true }).fill(password);
    await page.getByTestId(ID.inviteSubmit).click();

    // The account is signed in and, because the invitation carried a role, has the dashboard (not /no-access).
    await expectLandedOnSchemas(page, 60_000);
    await expectSignedInAs(page, email);
    const { rows } = await pg().query(`SELECT r.role, r."scopeKey" FROM user_roles r JOIN users u ON u.id = r."userId" WHERE u.email = $1`, [email]);
    expect(rows).toEqual([{ role: "VIEWER", scopeKey: `T:${await activeTenantId()}` }]);

    // Signed out, the same link is dead: the same card as for a token that never existed.
    await page.getByTestId(ID.userMenu).click();
    await page.getByTestId(ID.signOut).click();
    await expectLandedAt(page, "/login");
    await page.goto(`/invite/${token}`);
    await expect(page.getByTestId(ID.invalidLink)).toBeVisible();
    await expect(page.getByText(INVALID_LINK)).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
  });

  test("a reset link sets the new password, signs nobody in, works once, and kills the user's other reset links", { tag: ["@regression"] }, async ({ page }) => {
    const email = `${unique("e2e-reset-")}@example.com`.toLowerCase();
    const oldPassword = "the old passphrase 9";
    const newPassword = "marble-window-harvest-77";
    // Not in `registeredEmails`, for the reason given in the invitation test: the reset writes an immutable audit entry that points at this user.
    const user = await createUserWithPassword({ email, password: oldPassword });
    const { token } = await createResetTokenRow(user.id);
    const other = await createResetTokenRow(user.id);

    await page.goto(`/reset/${token}`);
    await waitForHydration(page.getByTestId(ID.resetForm));
    // No account is named on the page.
    await expect(page.getByText(email)).toHaveCount(0);
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm password", { exact: true }).fill(`${newPassword}x`);
    await page.getByTestId(ID.resetSubmit).click();
    await expect(page.getByTestId("reset-confirm-password-error")).toHaveText("Passwords do not match");
    // React empties an uncontrolled form once its action has answered: both passwords are typed again (a password is never put back in a field).
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm password", { exact: true }).fill(newPassword);
    await page.getByTestId(ID.resetSubmit).click();

    // To the login page, with a notice, and nobody signed in.
    await expectLandedAt(page, "/login", 60_000);
    await expect(page.getByTestId(ID.loginNotice)).toContainText("Your password was changed");
    expect(await hasSessionCookie(page)).toBe(false);

    // The old password no longer works; the new one does (the account holds no role: /no-access).
    await waitForHydration(page.getByTestId(ID.loginForm));
    await submitLogin(page, email, oldPassword);
    await expect(page.getByTestId(ID.loginError)).toHaveText(INVALID_CREDENTIALS);
    await passwordField(page).fill(newPassword);
    await page.getByTestId(ID.loginSubmit).click();
    await expectLandedAt(page, "/no-access");
    await page.getByTestId(ID.noAccessSignOut).click();
    await expectLandedAt(page, "/login");

    // The used link and the user's other outstanding link are dead, with the one message.
    for (const dead of [token, other.token]) {
      await page.goto(`/reset/${dead}`);
      await expect(page.getByTestId(ID.invalidLink)).toBeVisible();
      await expect(page.getByText(INVALID_LINK)).toBeVisible();
      await expect(page.locator("form")).toHaveCount(0);
    }
  });
});
