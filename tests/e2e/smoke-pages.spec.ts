/**
 * Page sweep: every dashboard page that the shell leads to (the table in fixtures/routes.ts: the ActivityBar, the admin tabs, and the
 * pages linked from them) loads and is healthy, as the logged-in admin:
 *
 *   - the document answers with a status below 400, and the address is the one asked for (not a redirect to /login);
 *   - nothing threw (`pageerror`), nothing logged an error to the console, no request of the page answered with a 5xx, none to this
 *     site with a 4xx (the document aside), none failed (the few known, harmless exceptions are in the ALLOWED_* constants, each with
 *     its reason; they are empty today);
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
import { test, expect } from "./helpers/fixtures";
import { centerPanel, leftSidebar } from "./helpers/event-builder";
import {
  ACTIVITY_BAR_ROUTES,
  ADMIN_TAB_ROUTES,
  DASHBOARD_ROUTES,
  HEALTH_API_PATH,
  type DashboardRoute,
} from "./fixtures/routes";

/**
 * What a healthy page may do that looks like a failure, each entry with why it is harmless. Nothing else is ignored: an unknown error
 * fails the page. The console and response lists are empty (no page of the sweep did any of it when this was written); the request
 * list has the one kind of cancelled request below. Add a row, with its reason, only for something that is a fact of a browser or of
 * the framework and not of the app.
 */
const ALLOWED_CONSOLE_ERRORS: ReadonlyArray<{ match: RegExp; reason: string }> = [];
/** Matched against `<METHOD> <url> <status>`. */
const ALLOWED_FAILED_RESPONSES: ReadonlyArray<{ match: RegExp; reason: string }> = [];
/** Matched against `<METHOD> <url> <error text>`, with " [server action]" added to a request that carries a Next server action. */
const ALLOWED_FAILED_REQUESTS: ReadonlyArray<{ match: RegExp; reason: string }> = [
  {
    // Chromium says net::ERR_ABORTED, Firefox NS_BINDING_ABORTED, WebKit "cancelled".
    match: /^GET \S+\?_rsc=\S+ (net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled)$/i,
    reason:
      "Next.js prefetches the RSC payload of every <Link> in view (the ActivityBar's seven) and cancels a prefetch that is still running when the " +
      "link re-renders or the page changes; a cancelled prefetch is not a failure of the page (the page it was a prefetch FROM loaded, which the " +
      "other checks prove), and only this one kind of request is excused.",
  },
  {
    match: /^POST \S+ (net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled) \[server action\]$/i,
    reason:
      "A client page fetches its data with a server action when it mounts, and Next.js drops the transport of an action that is still in " +
      "flight when the router state is renewed (about 200 ms after the load, together with the cancelled prefetches above). Not excused " +
      "blindly: a page whose action was lost would stay on its loading text or lack its content, and every page of the sweep checks that " +
      "its heading is there and that no `Loading...` text is left; a server action that FAILED answers with a status (the 5xx check).",
  },
];

const isAllowed = (list: ReadonlyArray<{ match: RegExp }>, text: string): boolean => list.some((entry) => entry.match.test(text));

/**
 * What a page did wrong while it loaded, from the moment of the call: an error it threw, a `console.error`, a 5xx answer, a 4xx
 * answer from this site (the document itself is checked on its own), and a request that failed. The last two are counted here and
 * not left to the console's echo ("Failed to load resource") because only Chromium logs that: Firefox and WebKit would pass a page
 * whose script request answered 404.
 */
function watchPage(page: Page, baseURL: string): { problems: string[] } {
  const problems: string[] = [];
  const origin = new URL(baseURL).origin;
  page.on("pageerror", (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!isAllowed(ALLOWED_CONSOLE_ERRORS, text)) problems.push(`console.error: ${text} (${message.location().url})`);
  });
  page.on("response", (response) => {
    const request = response.request();
    const status = response.status();
    const isDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
    const sameOrigin = new URL(response.url()).origin === origin;
    const failed = status >= 500 || (status >= 400 && sameOrigin && !isDocument);
    if (failed && !isAllowed(ALLOWED_FAILED_RESPONSES, `${request.method()} ${response.url()} ${status}`)) {
      problems.push(`HTTP ${status}: ${request.method()} ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const serverAction = request.headers()["next-action"] ? " [server action]" : "";
    const text = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}${serverAction}`;
    if (!isAllowed(ALLOWED_FAILED_REQUESTS, text)) problems.push(`request failed: ${text}`);
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

async function expectHealthyPage(page: Page, route: DashboardRoute, baseURL: string): Promise<void> {
  const watch = watchPage(page, baseURL);

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
    test(`${route.name} (${route.path}) loads without errors`, { tag: ["@smoke", "@regression"] }, async ({ authedPage: page, baseURL }) => {
      await expectHealthyPage(page, route, baseURL!);
    });
  }

  for (const route of OTHER_ROUTES) {
    test(`${route.name} (${route.path}) loads without errors`, { tag: ["@regression"] }, async ({ authedPage: page, baseURL }) => {
      await expectHealthyPage(page, route, baseURL!);
    });
  }
});

test.describe("the sweep's detectors", () => {
  // A canary: the sweep above is only worth something if a broken page would fail it. Each detector is fired by hand here.
  test("the watcher reports a console error, a thrown error, a 5xx, a 4xx of this site and a failed request", { tag: ["@regression"] }, async ({
    authedPage: page,
    baseURL,
  }) => {
    await page.goto("/glossary");
    await expect(headingOf(page, DASHBOARD_ROUTES.find((route) => route.path === "/glossary")!)).toBeVisible();
    const watch = watchPage(page, baseURL!);

    await page.route("**/api/v1/health", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await page.route("**/canary-missing-asset.js", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }));
    await page.route("**/canary-dropped-request", (route) => route.abort("connectionrefused"));
    await page.evaluate(() => {
      console.error("canary console error");
      queueMicrotask(() => {
        throw new Error("canary thrown error");
      });
      void fetch("/api/v1/health");
      void fetch("/canary-missing-asset.js");
      void fetch("/canary-dropped-request").catch(() => {});
    });

    // (Chrome also logs "Failed to load resource" for the answers: the watcher counts them itself, so Firefox and WebKit report them too.)
    const reported = () => watch.problems.join("\n");
    await expect.poll(reported, { message: "the watcher missed the console error" }).toContain("console.error: canary console error");
    await expect.poll(reported, { message: "the watcher missed the thrown error" }).toContain("pageerror: canary thrown error");
    await expect.poll(reported, { message: "the watcher missed the 5xx answer" }).toContain("HTTP 503: GET");
    await expect.poll(reported, { message: "the watcher missed the 404 of this site" }).toContain("HTTP 404: GET");
    await expect.poll(reported, { message: "the watcher missed the failed request" }).toContain("request failed: GET");
    // The allow-lists are lists of explicit patterns, not a switch: an entry names its reason.
    for (const list of [ALLOWED_CONSOLE_ERRORS, ALLOWED_FAILED_RESPONSES, ALLOWED_FAILED_REQUESTS]) {
      expect(list.every((entry) => entry.reason.trim().length >= 10)).toBe(true);
    }
  });
});

test.describe("the shell leads to those pages", () => {
  test("each ActivityBar item opens its page", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    // From a page that is not an ActivityBar item, so that every item, the first too, has to NAVIGATE (clicking the item of the page
    // one is on would pass without doing anything).
    await page.goto("/notifications");
    await expectShell(page);

    for (const route of ACTIVITY_BAR_ROUTES) {
      expect(new URL(page.url()).pathname, `${route.navTestId} is the page the test is already on`).not.toBe(route.path);
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
    // 200 within a few tries: a probe that has just started the app may find the database slow for a moment ("degraded" is still 200;
    // only a failing or a hung database is 503).
    let response = await request.get(HEALTH_API_PATH, { maxRedirects: 0 });
    await expect
      .poll(
        async () => {
          response = await request.get(HEALTH_API_PATH, { maxRedirects: 0 });
          return response.status();
        },
        { message: "the health endpoint never answered 200 (a redirect to /login, or a failing database)", intervals: [250, 500, 1000, 2000], timeout: 30_000 },
      )
      .toBe(200);
    expect(response.headers()["content-type"]).toMatch(/application\/json/);

    const body = (await response.json()) as {
      status: string;
      timestamp: string;
      components: Record<string, { name: string; status: string }>;
    };
    // 200 is "healthy" or "degraded" (an unhealthy system answers 503).
    expect(["healthy", "degraded"]).toContain(body.status);
    // Whatever it says, it says it in words of its own: nothing of the database's error.
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|password|postgresql:\/\//i);
    expect(Object.keys(body.components).sort()).toEqual(["compiler", "database", "emitters"]);
    expect(body.components.database.status, "the app cannot reach its database").not.toBe("unhealthy");
    expect(Number.isNaN(Date.parse(body.timestamp)), `timestamp ${body.timestamp} is not a date`).toBe(false);
  });
});
