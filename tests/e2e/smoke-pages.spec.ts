/**
 * Page sweep: every dashboard page that the shell leads to (the table in fixtures/routes.ts: the ActivityBar, the admin tabs, and the
 * pages linked from them) loads and is healthy, as the logged-in admin:
 *
 *   - the document answers with a status below 400, and the address is the one asked for (not a redirect to /login);
 *   - nothing threw (`pageerror`), nothing logged an error to the console (the few known, harmless messages are in
 *     ALLOWED_CONSOLE_ERRORS, each with its reason), and no request of the page answered with a 5xx;
 *   - neither the dashboard error boundary (`dashboard-error`, src/app/(dashboard)/error.tsx) nor the not-found page
 *     (`dashboard-not-found`) is on screen, and no loading text is left over;
 *   - the shell is there (top bar, ActivityBar, the explorer loaded) and the page shows its own heading.
 *
 * The pull-request pages (`@smoke`) are Domains, Glossary, Governance and the Admin root; the rest is `@regression`. Two more tests
 * check that the ActivityBar and the admin tabs LEAD to those pages by clicking, and that the unauthenticated health endpoint answers.
 *
 * Page content is queried inside the center panel and the explorer through `leftSidebar` (helpers/event-builder.ts): a hard load
 * streams a page behind its loading.tsx and Next leaves a hidden copy of the streamed segment in <body>.
 */
import type { Page } from "@playwright/test";
import { test, expect as baseExpect } from "./helpers/fixtures";
import { centerPanel, leftSidebar } from "./helpers/event-builder";
import {
  ACTIVITY_BAR_ROUTES,
  ADMIN_TAB_ROUTES,
  DASHBOARD_ROUTES,
  HEALTH_API_PATH,
  type DashboardRoute,
} from "./fixtures/routes";

/**
 * Every assertion below waits for the server: a page render and the fetches of the page behind it. Measured on the hierarchy spec (the same server work): a domain is
 * created in 0.1 s when the suite runs with one worker (as CI does), and in 4 s when eight workers use the one server, which is
 * just under `expect`'s default 5 s and what made the first version of these specs fail now and then. They wait up to the 30 s of
 * `actionTimeout` (playwright.config.ts) instead; an assertion that holds returns at once.
 */
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * Console errors that a healthy page may log, each one with why it is harmless. Nothing else is ignored: an unknown error fails the
 * page. (Empty: no page logged one when this was written. Add a row, with its reason, only for a message that is a fact of the
 * browser and not of the app.)
 */
const ALLOWED_CONSOLE_ERRORS: ReadonlyArray<{ match: RegExp; reason: string }> = [];

const isAllowed = (text: string): boolean => ALLOWED_CONSOLE_ERRORS.some((entry) => entry.match.test(text));

/** What a page did wrong while it loaded: errors it threw or logged, and 5xx answers. Collected from the moment of the call. */
function watchPage(page: Page): { problems: string[] } {
  const problems: string[] = [];
  page.on("pageerror", (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!isAllowed(text)) problems.push(`console.error: ${text} (${message.location().url})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return { problems };
}

/** Text a page shows while it fetches (`Loading users…`, `Loading concepts...`, `Loading...`): none may be left once the page has settled. */
const LOADING_TEXT = /^Loading\b.*(\.\.\.|…)$/;

async function expectShell(page: Page): Promise<void> {
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page.getByTestId("activity-bar")).toBeVisible();
  // The explorer replaces its skeleton once its tree has loaded; its Enterprise row is the first thing in it.
  await expect(leftSidebar(page).getByTestId("enterprise")).toBeVisible({ timeout: 30_000 });
}

/** The page's own heading, by its accessible name and level, inside the center panel. */
const headingOf = (page: Page, route: DashboardRoute) =>
  centerPanel(page).getByRole("heading", { name: route.heading, exact: true, level: route.level });

async function expectRoutePage(page: Page, route: DashboardRoute): Promise<void> {
  await expect(headingOf(page, route), `${route.path}: the heading "${route.heading}" is not on the page`).toBeVisible();
  if (route.adminTab) await expect(page.getByTestId(route.adminTab.testId)).toHaveAttribute("aria-selected", "true");
}

async function expectHealthyPage(page: Page, route: DashboardRoute): Promise<void> {
  const watch = watchPage(page);

  const response = await page.goto(route.path);
  expect(response, `${route.path}: no document response`).not.toBeNull();
  expect(response!.status(), `${route.path}: the document answered ${response!.status()}`).toBeLessThan(400);
  expect(new URL(page.url()).pathname, `${route.path}: the browser ended up somewhere else`).toBe(route.path);

  await expectRoutePage(page, route);
  await expectShell(page);

  // Settled: nothing is loading any more, so what a late fetch logs has been logged.
  await expect(centerPanel(page).getByText(LOADING_TEXT), `${route.path}: still loading`).toHaveCount(0);
  await expect(page.getByTestId("dashboard-error"), `${route.path}: the error boundary is on screen`).toHaveCount(0);
  await expect(page.getByTestId("dashboard-not-found"), `${route.path}: the not-found page is on screen`).toHaveCount(0);
  await expect(page.getByText("Application error: a client-side exception has occurred")).toHaveCount(0);

  expect(watch.problems, `${route.path}: the page threw, logged an error, or a request failed`).toEqual([]);
}

const SMOKE_ROUTES = DASHBOARD_ROUTES.filter((route) => route.smoke);
const OTHER_ROUTES = DASHBOARD_ROUTES.filter((route) => !route.smoke);

test.describe("dashboard pages load", () => {
  for (const route of SMOKE_ROUTES) {
    test(`${route.name} (${route.path}) loads without errors`, { tag: ["@smoke", "@regression"] }, async ({ authedPage: page }) => {
      await expectHealthyPage(page, route);
    });
  }

  for (const route of OTHER_ROUTES) {
    test(`${route.name} (${route.path}) loads without errors`, { tag: ["@regression"] }, async ({ authedPage: page }) => {
      await expectHealthyPage(page, route);
    });
  }
});

test.describe("the sweep's detectors", () => {
  // A canary: the sweep above is only worth something if a broken page would fail it. Each detector is fired by hand here.
  test("the watcher reports a console error, a thrown error and a 5xx answer; the allow-list lets a listed message through", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    await page.goto("/glossary");
    await expect(headingOf(page, DASHBOARD_ROUTES.find((route) => route.path === "/glossary")!)).toBeVisible();
    const watch = watchPage(page);

    await page.route("**/api/v1/health", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await page.evaluate(() => {
      console.error("canary console error");
      queueMicrotask(() => {
        throw new Error("canary thrown error");
      });
      void fetch("/api/v1/health");
    });

    // (Chrome also logs "Failed to load resource" for the 503: an error of the page, which the sweep must not ignore either.)
    const reported = () => watch.problems.join("\n");
    await expect.poll(reported, { message: "the watcher missed the console error" }).toContain("console.error: canary console error");
    await expect.poll(reported, { message: "the watcher missed the thrown error" }).toContain("pageerror: canary thrown error");
    await expect.poll(reported, { message: "the watcher missed the 5xx answer" }).toContain("HTTP 503: GET");
    // The allow-list is a list of explicit patterns, not a switch: nothing is on it unless it names a reason.
    expect(ALLOWED_CONSOLE_ERRORS.every((entry) => entry.reason.trim().length >= 10)).toBe(true);
  });
});

test.describe("the shell leads to those pages", () => {
  test("each ActivityBar item opens its page", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await page.goto("/schemas");
    await expectShell(page);

    for (const route of ACTIVITY_BAR_ROUTES) {
      await page.getByTestId(route.navTestId!).click();
      await expect(page, `${route.navTestId} did not lead to ${route.path}`).toHaveURL((url) => url.pathname === route.path);
      await expectRoutePage(page, route);
      await expect(page.getByTestId("dashboard-error")).toHaveCount(0);
      await expect(page.getByTestId("dashboard-not-found")).toHaveCount(0);
    }
  });

  test("each admin tab opens its page and is the selected one", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await page.goto("/admin");
    await expectShell(page);

    for (const route of ADMIN_TAB_ROUTES) {
      await page.getByTestId(route.adminTab!.testId).click();
      await expect(page, `${route.adminTab!.testId} did not lead to ${route.path}`).toHaveURL((url) => url.pathname === route.path);
      await expectRoutePage(page, route);
      // One tab is selected at a time.
      await expect(page.locator('[data-testid^="admin-tab-"][aria-selected="true"]')).toHaveCount(1);
    }
  });
});

test.describe("health endpoint", () => {
  // The monitoring tools call it without a session: no cookie of the admin's reaches it.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("GET /api/v1/health answers 200 with JSON, without a login", { tag: ["@smoke", "@regression"] }, async ({ request }) => {
    const response = await request.get(HEALTH_API_PATH, { maxRedirects: 0 });

    expect(response.status(), "the health endpoint must not redirect to /login or fail").toBe(200);
    expect(response.headers()["content-type"]).toMatch(/application\/json/);

    const body = (await response.json()) as {
      status: string;
      timestamp: string;
      components: Record<string, { name: string; status: string }>;
    };
    // 200 is "healthy" or "degraded" (an unhealthy system answers 503).
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(Object.keys(body.components).sort()).toEqual(["compiler", "database", "emitters"]);
    expect(body.components.database.status, "the app cannot reach its database").not.toBe("unhealthy");
    expect(Number.isNaN(Date.parse(body.timestamp)), `timestamp ${body.timestamp} is not a date`).toBe(false);
  });
});
