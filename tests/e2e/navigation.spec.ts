/**
 * Navigation E2E (Story 13.9): every explorer node and breadcrumb resolves,
 * legacy URLs still land, a tenant-level entity is reachable from the sidebar,
 * and no `/schemas` link rendered on a workspace page 404s.
 *
 * PREREQS: see helpers/auth.ts. Runs against an existing dev server
 * (`reuseExistingServer`); the first visit of each route compiles in dev, so the
 * navigation/action timeouts below are deliberately generous.
 *
 * Why the extra body check: a `notFound()` thrown after a route's `loading.tsx`
 * has started streaming still answers 200 (verified against this app: unknown
 * `/schemas/...` URLs return 200), so a status code alone cannot prove a page
 * resolved. Server-side health therefore also looks for the not-found digest in
 * the streamed document, and client-side health for the rendered 404 copy. (The
 * 404 *copy* is also present in every healthy page's flight payload, so it is
 * only meaningful in the DOM, never in the raw body.)
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, unique } from "./helpers/auth";

test.use({ navigationTimeout: 60_000, actionTimeout: 30_000 });

const NOT_FOUND_COPY = "This page could not be found";
/** Present in the streamed document only when the route rendered Next's not-found boundary. */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

/**
 * GET with a retry on transport errors only (e.g. the dev server aborting a streamed
 * response while another worker's server action recompiles); HTTP statuses are returned as-is.
 */
async function getWithRetry(request: APIRequestContext, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await request.get(url, { timeout: 60_000 });
      return { status: res.status(), body: await res.text() };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Server-side health of a URL: a followed GET must succeed and not render the 404 page. */
async function expectResolves(request: APIRequestContext, url: string, from = "the page") {
  const { status, body } = await getWithRetry(request, url);
  expect(status, `broken link ${url} on ${from}`).toBeLessThan(400);
  expect(body, `${url} (linked from ${from}) rendered the 404 page`).not.toContain(NOT_FOUND_DIGEST);
}

/** Client-side health: the current document shows no 404 page. */
async function expectNoNotFoundPage(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const where = page.url();
  await expect(page.getByText(NOT_FOUND_COPY), `${where} rendered the 404 page`).toHaveCount(0);
  await expect(page.locator("h1.next-error-h1"), `${where} rendered the 404 page`).toHaveCount(0);
}

/** Wait for the explorer tree to load (the skeleton has no "enterprise" row). */
async function openExplorer(page: Page) {
  await page.goto("/schemas");
  await expect(page.getByTestId("left-sidebar").getByTestId("enterprise")).toBeVisible({
    timeout: 30_000,
  });
  // During the Suspense swap the fallback and the loaded explorer can briefly coexist.
  await expect(page.getByTestId("left-sidebar")).toHaveCount(1, { timeout: 15_000 });
}

/**
 * Expand every collapsed explorer node so all category rows are rendered.
 * Toggles are functional state updates, so all currently collapsed nodes are
 * clicked in one tick; nodes revealed by that re-render are picked up by the next pass.
 */
async function expandAll(page: Page) {
  const sidebar = page.getByTestId("left-sidebar");
  for (let pass = 0; pass < 10; pass++) {
    const clicked = await sidebar.evaluate(async (root) => {
      const collapsed = Array.from(
        root.querySelectorAll<HTMLButtonElement>("button[aria-expanded='false']")
      );
      collapsed.forEach((button) => button.click());
      // Let React commit before the next pass looks for newly revealed nodes.
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
      return collapsed.length;
    });
    if (clicked === 0) return;
  }
  await expect(sidebar.locator("button[aria-expanded='false']")).toHaveCount(0);
}

const NODE_ID = /^(enterprise|domain-.+|product-.+|entity-.+)$/;
/** Entity leaf rows are many and identical in behavior; sample a few. */
const ENTITY_ROW_SAMPLE = 4;

test.describe("navigation", () => {
  // Serial, and the entity-creating test last: it creates and then deletes a
  // tenant-level entity, which the sidebar click-through and the link crawl would
  // otherwise see mid-flight (a crawled link to the entity 404s once it is deleted).
  test.describe.configure({ mode: "serial" });

  test("every sidebar node and breadcrumb resolves", async ({ authedPage: page }) => {
    test.setTimeout(600_000);

    await openExplorer(page);
    await expandAll(page);
    const sidebar = page.getByTestId("left-sidebar");

    const allIds = await sidebar
      .locator("[data-testid]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
    const ids = allIds.filter((id) => NODE_ID.test(id));
    const entityIds = ids.filter((id) => id.startsWith("entity-")).slice(0, ENTITY_ROW_SAMPLE);
    const nodeIds = [...ids.filter((id) => !id.startsWith("entity-")), ...entityIds];

    // The seeded workspace always has the Enterprise node; categories hide when empty,
    // so only the node itself is guaranteed.
    expect(nodeIds).toContain("enterprise");

    console.log(`sidebar click-through: ${nodeIds.length} nodes (${entityIds.length} entity rows sampled)`);
    const breadcrumbsChecked = new Set<string>();
    const urlsChecked = new Set<string>();
    for (const id of nodeIds) {
      // Always start from /schemas: no row is active there, so `data-active`
      // flipping to true (plus the URL leaving /schemas) proves the click navigated.
      await openExplorer(page);
      await expandAll(page);
      const row = sidebar.getByTestId(id);
      await row.scrollIntoViewIfNeeded();
      await row.click();

      await expect(page, `clicking ${id} did not navigate`).toHaveURL(/\/schemas\/.+/);
      await expect(row, `${id} not active after navigation`).toHaveAttribute("data-active", "true");
      await expect(row).toHaveAttribute("data-pending", "false");
      await expectNoNotFoundPage(page);

      // Server-side health of the exact URL the sidebar landed on.
      if (!urlsChecked.has(page.url())) {
        urlsChecked.add(page.url());
        await expectResolves(page.request, page.url(), `sidebar node ${id}`);
      }

      // Breadcrumbs on the landed page.
      const crumbs = await page
        .getByTestId("center-panel")
        .locator("nav a[href^='/schemas']")
        .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
      for (const href of crumbs) {
        if (!href || breadcrumbsChecked.has(href)) continue;
        breadcrumbsChecked.add(href);
        await expectResolves(page.request, href, `breadcrumb on ${page.url()}`);
      }
    }
    console.log(`sidebar click-through: ${urlsChecked.size} distinct URLs, ${breadcrumbsChecked.size} breadcrumb links checked`);
  });

  test("legacy links still land", async ({ authedPage: page }) => {
    // `?tab=types` is the legacy alias of the `data-types` tab.
    const res = await page.goto("/schemas/enterprise?tab=types");
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("#enterprise-tab-data-types")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expectNoNotFoundPage(page);

    // Likewise for the explicit tabs.
    const entities = await page.goto("/schemas/enterprise?tab=entities");
    expect(entities?.status()).toBeLessThan(400);
    await expect(page.locator("#enterprise-tab-entities")).toHaveAttribute("aria-selected", "true");
  });

  test("link crawl: no rendered href on workspace pages 404s", async ({ authedPage: page }) => {
    test.setTimeout(900_000);

    const MAX_PAGES = 200;
    const start = [
      "/schemas",
      "/schemas/enterprise",
      "/schemas/enterprise?tab=data-types",
      "/schemas/enterprise?tab=entities",
    ];
    const seen = new Set<string>();
    const queue = [...start];
    let legacyChecked = false;

    const normalize = (href: string) => href.split("#")[0];

    while (queue.length && seen.size < MAX_PAGES) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);

      const res = await page.goto(url);
      expect(res?.status(), `broken link ${url}`).toBeLessThan(400);
      await expectNoNotFoundPage(page);

      const hrefs = await page.$$eval("a[href^='/schemas']", (as) =>
        as.map((a) => a.getAttribute("href") ?? "")
      );
      for (const raw of hrefs) {
        const href = normalize(raw);
        if (!href || href.includes("/api/") || seen.has(href) || queue.includes(href)) continue;
        queue.push(href);
      }

      // A product entity page doubles as the legacy 2-segment redirect fixture:
      // /schemas/<domain>/<product>/<entity> -> /schemas/<domain>/<entity> must land back.
      const parts = new URL(url, "http://x").pathname.split("/").filter(Boolean);
      if (!legacyChecked && parts.length === 4 && parts[1] !== "enterprise") {
        const [, domain, , entity] = parts;
        const legacy = await page.goto(`/schemas/${domain}/${entity}`);
        expect(legacy?.status(), `legacy URL /schemas/${domain}/${entity}`).toBeLessThan(400);
        // The redirect() fires after loading.tsx streamed, so it completes client-side.
        const canonical = `/${parts.join("/")}`;
        await page.waitForURL((u) => u.pathname === canonical, { timeout: 30_000 });
        await expectNoNotFoundPage(page);
        legacyChecked = true;
      }
    }

    // Surface how much of the app the crawl actually exercised.
    const byDepth = [...seen].reduce<Record<number, number>>((acc, u) => {
      const depth = new URL(u, "http://x").pathname.split("/").filter(Boolean).length;
      acc[depth] = (acc[depth] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `link crawl visited ${seen.size} pages (by path depth: ${JSON.stringify(byDepth)}); legacy redirect checked: ${legacyChecked}`
    );
    expect(seen.size).toBeGreaterThan(start.length - 1);
  });

  test("tenant-level entity is reachable from the sidebar", async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const name = unique("Ent");
    let created = false;

    try {
      await page.goto("/schemas/enterprise/new");
      await page.getByRole("button", { name: /start blank/i }).click();
      await page.getByPlaceholder("EntityName").fill(name);
      await page.getByRole("button", { name: /create entity/i }).click();
      await page.waitForURL(/\/schemas\/enterprise\/entities\//, { timeout: 60_000 });
      created = true;
      const entityUrl = page.url();
      await expect(page.getByRole("heading", { name: new RegExp(name, "i") }).first()).toBeVisible();

      // Reach it from the sidebar, starting somewhere that is not its page.
      await openExplorer(page);
      const row = page.getByTestId("left-sidebar").getByText(name, { exact: true });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await expect(page).toHaveURL(/\/schemas\/enterprise\/entities\//);
      expect(page.url()).toBe(entityUrl);
      await expectNoNotFoundPage(page);
    } finally {
      // Cleanup through the UI so no test entity lingers in the shared dev DB.
      if (created) {
        await page.getByRole("button", { name: /^delete$/i }).click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^delete$/i })
          .click();
        await page.waitForURL(/\/schemas\/enterprise$/, { timeout: 60_000 });
      }
    }
  });
});
