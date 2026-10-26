/**
 * Plain helpers for the specs that drive the Admin Users screen and sign people in and out of browser contexts of their own
 * (`user-management.spec.ts`): open the screen, find a person's row and panel, make an invitation through the dialog, sign somebody in through the login
 * page in a fresh context, and capture a server action a page made so a spec can POST it again with other arguments (the server's own refusals, which the
 * screen never lets a person trigger because it disables the control first). A helper drives the real UI and returns what the page said; it never decides
 * what a spec asserts.
 *
 * The page is queried inside the center panel (`centerPanel`, helpers/event-builder.ts): a hard load streams it behind its loading.tsx and Next leaves a
 * hidden copy of the streamed segment in <body>. Dialogs render in portals outside the center panel and are queried on `page`.
 */
import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { centerPanel } from "./event-builder";
import { waitForHydration } from "./hydration";

export const NEW_PASSWORD_LABEL = "New password";
export const CONFIRM_PASSWORD_LABEL = "Confirm password";

/** Open /admin (the Users tab) and wait until the list has loaded and the screen is interactive. */
export async function openUsersPage(page: Page): Promise<void> {
  await page.goto("/admin");
  await expect(centerPanel(page).getByRole("heading", { name: "Users", level: 2 })).toBeVisible();
  await expect(centerPanel(page).getByText("Loading users…")).toHaveCount(0);
  await waitForHydration(centerPanel(page).getByTestId("invite-user-open"));
}

/** The row of a person (an account) in the list, narrowed by the filter box (the list holds every user of the database). */
export async function userRowOf(page: Page, email: string): Promise<Locator> {
  await centerPanel(page).getByTestId("user-filter").fill(email);
  const row = centerPanel(page).locator(`[data-testid="user-row"][data-email="${email}"]`);
  await expect(row).toBeVisible();
  return row;
}

/** The row of a pending invitation, narrowed the same way. */
export async function invitationRowOf(page: Page, email: string): Promise<Locator> {
  await centerPanel(page).getByTestId("user-filter").fill(email);
  const row = centerPanel(page).locator(`[data-testid="invitation-row"][data-email="${email}"]`);
  await expect(row).toBeVisible();
  return row;
}

export const userPanel = (page: Page): Locator => centerPanel(page).getByTestId("user-detail-panel");

/** Open the person's detail panel (a click on the row) and wait for it to show them. */
export async function openUserPanel(page: Page, email: string): Promise<Locator> {
  await (await userRowOf(page, email)).click();
  await expect(userPanel(page)).toHaveAttribute("data-email", email);
  return userPanel(page);
}

/**
 * Make an invitation through the dialog: the e-mail, one role at a scope chosen from the lists (a tenant by its name, optionally one of its domains by name)
 * and Create. Resolves with the one-time link the dialog shows (the address as shown, absolute); the dialog is left open on its result.
 */
export async function inviteViaDialog(page: Page, input: { email: string; role: string; tenantLabel: string; domainLabel?: string }): Promise<{ link: string; dialog: Locator }> {
  await centerPanel(page).getByTestId("invite-user-open").click();
  const dialog = page.getByTestId("invite-user-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Email address").fill(input.email);
  await dialog.getByTestId("invite-role").selectOption(input.role);
  await dialog.getByTestId("scope-tenant").selectOption({ label: input.tenantLabel });
  if (input.domainLabel) await dialog.getByTestId("scope-domain").selectOption({ label: input.domainLabel });
  await dialog.getByTestId("invite-submit").click();
  const field = dialog.getByTestId("invite-link");
  await expect(field).toBeVisible({ timeout: 30_000 });
  return { link: await field.inputValue(), dialog };
}

/** A fresh browser context with no session at all (nothing of the admin's, nothing of an earlier test). Close it when done. */
export async function freshContext(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
}

/** The path of a link the dialog showed (the page joins its own origin to it; the test opens it against its own base URL). */
export const pathOf = (link: string): string => {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
};

/** Fill the new-password pair of the invitation and reset pages and submit nothing (the caller clicks its own button). */
export async function fillNewPassword(page: Page, password: string, confirmation = password): Promise<void> {
  await page.getByLabel(NEW_PASSWORD_LABEL, { exact: true }).fill(password);
  await page.getByLabel(CONFIRM_PASSWORD_LABEL, { exact: true }).fill(confirmation);
}

/** Sign somebody in through the login page of `page` and wait until the app has taken them to the dashboard. */
export async function signInThroughLoginPage(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await waitForHydration(page.getByTestId("login-form"));
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL((url) => url.pathname === "/schemas", { timeout: 60_000 });
}

/** A server action a page made, as it went over the wire: where to, which action, how the arguments were encoded. */
export interface CapturedAction {
  url: string;
  actionId: string;
  contentType: string;
  body: string;
}

/**
 * Run `trigger` and capture the first server action POSTed after it whose body contains `bodyIncludes` (name what only that call holds: the id it acts on).
 * The capture can be sent again with other arguments (`replayAction`): the way a spec reaches the server's refusal of an act the screen disables.
 */
export async function captureAction(page: Page, trigger: () => Promise<void>, bodyIncludes: string): Promise<CapturedAction> {
  const started = page.waitForRequest((request) => request.method() === "POST" && "next-action" in request.headers() && (request.postData() ?? "").includes(bodyIncludes));
  await trigger();
  const request = await started;
  const headers = request.headers();
  return { url: request.url(), actionId: headers["next-action"], contentType: headers["content-type"] ?? "text/plain;charset=UTF-8", body: request.postData() ?? "" };
}

/** POST a captured action again with `body` (the same encoding, other arguments) as the page's own session; resolves with the text of the answer. */
export async function replayAction(page: Page, captured: CapturedAction, body: string): Promise<{ status: number; text: string }> {
  const origin = new URL(captured.url).origin;
  const response = await page.request.post(captured.url, {
    headers: { "next-action": captured.actionId, "content-type": captured.contentType, accept: "text/x-component", origin },
    data: body,
    maxRedirects: 0,
  });
  return { status: response.status(), text: await response.text() };
}
