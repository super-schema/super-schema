/**
 * Navigation E2E (Story 13.9): every explorer node and breadcrumb resolves,
 * legacy URLs still land, a tenant-level entity is reachable from the sidebar,
 * and no `/schemas` link rendered on a workspace page 404s.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (fixtures are created straight in
 * the PostgreSQL database in `beforeAll` and deleted in `afterAll`, so coverage never
 * depends on what the dev DB happens to contain, and a run leaves no rows behind).
 * Runs against an existing dev server (`reuseExistingServer`); the first visit of
 * each route compiles in dev, so the timeouts below are deliberately generous.
 *
 * Why the extra body check: a `notFound()` thrown after a route's `loading.tsx`
 * has started streaming still answers 200 (verified against this app: unknown
 * `/schemas/...` URLs return 200), so a status code alone cannot prove a page
 * resolved. Server-side health therefore also looks for the not-found digest in
 * the streamed document, and client-side health for the rendered 404 copy. (The
 * 404 *copy* is also present in every healthy page's flight payload, so it is
 * only meaningful in the DOM, never in the raw body.) The first test is a canary
 * that proves both detectors still fire, so marker drift fails loudly instead of
 * silently turning every health check into a no-op.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, unique } from "./helpers/fixtures";
import {
  createNavFixtures,
  deleteNavFixtures,
  deleteTenantEntitiesByName,
  disconnectDb,
  type NavFixtures,
} from "./helpers/db";

const NOT_FOUND_COPY = "This page could not be found";
/** Present in the streamed document only when the route rendered Next's not-found boundary. */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

const notFoundCopy = (page: Page) => page.getByText(NOT_FOUND_COPY);
const notFoundHeading = (page: Page) => page.locator("h1.next-error-h1");

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

const bodyIsNotFound = (body: string) => body.includes(NOT_FOUND_DIGEST);

/** Server-side health of a URL: a followed GET must succeed and not render the 404 page. */
async function expectResolves(request: APIRequestContext, url: string, from = "the page") {
  const { status, body } = await getWithRetry(request, url);
  expect(status, `broken link ${url} on ${from}`).toBeLessThan(400);
  expect(bodyIsNotFound(body), `${url} (linked from ${from}) rendered the 404 page`).toBe(false);
}

/**
 * Client-side health: the current document shows no 404 page.
 *
 * A route streams behind its loading.tsx (a PageSkeleton) and a `notFound()` thrown after that replaces the skeleton, so "no 404 copy"
 * only means something once the skeleton is gone. That is what is waited for (a web-first assertion, retried until it holds or fails
 * loudly), instead of a guess that the network went quiet.
 */
async function expectNoNotFoundPage(page: Page) {
  const where = page.url();
  await expect(page.getByTestId("center-panel"), `${where} never rendered the shell`).toBeVisible();
  await expect(page.locator('[data-testid^="skeleton-"]:visible'), `${where} is still on its loading skeleton`).toHaveCount(0);
  await expect(notFoundCopy(page), `${where} rendered the 404 page`).toHaveCount(0);
  await expect(notFoundHeading(page), `${where} rendered the 404 page`).toHaveCount(0);
}

/** Wait for the explorer tree to load: the loading skeleton is `left-sidebar-fallback` and has no "enterprise" row. */
async function openExplorer(page: Page) {
  await page.goto("/schemas");
  await expect(page.getByTestId("left-sidebar").getByTestId("enterprise")).toBeVisible({
    timeout: 30_000,
  });
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

const CATEGORY_SUFFIX = /-(data-types|apis|entities)$/;

/** Which explorer scope/kind a sidebar test id belongs to; null for ids that are not nodes. */
function bucketOf(id: string): string | null {
  if (id === "enterprise" || id.startsWith("enterprise-")) return "enterprise";
  const isCategory = CATEGORY_SUFFIX.test(id);
  if (id.startsWith("domain-")) return isCategory ? "domain-category" : "domain";
  if (id.startsWith("product-")) return isCategory ? "product-category" : "product";
  if (id.startsWith("entity-")) return "entity";
  return null;
}

/** Non-fixture nodes sampled per bucket, so the click-through does not grow with accumulated rows. */
const SAMPLE_PER_BUCKET = 2;

test.describe("navigation", () => {
  // Serial, with the entity-creating UI test last: it creates and then deletes a
  // tenant-level entity, which the sidebar click-through and the link crawl would
  // otherwise see mid-flight (a crawled link to the entity 404s once it is deleted).
  test.describe.configure({ mode: "serial" });

  let fx: NavFixtures;

  test.beforeAll(async () => {
    fx = await createNavFixtures();
  });

  test.afterAll(async () => {
    try {
      await deleteNavFixtures(fx);
    } finally {
      await disconnectDb();
    }
  });

  const paths = () => ({
    domain: `/schemas/${fx.domain.slug}`,
    product: `/schemas/${fx.domain.slug}/${fx.product.slug}`,
    productEntity: `/schemas/${fx.domain.slug}/${fx.product.slug}/${fx.productEntity.slug}`,
    tenantEntity: `/schemas/enterprise/entities/${fx.tenantEntity.slug}`,
  });

  test("canary: both 404 detectors fire on a known-missing route", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const url = `/schemas/zzz-${unique("nope-")}`;

    // Server side: the streamed body carries the not-found digest, and the health helper rejects it.
    const { body } = await getWithRetry(page.request, url);
    expect(bodyIsNotFound(body), `digest ${NOT_FOUND_DIGEST} missing from a missing route's body`).toBe(true);
    await expect(expectResolves(page.request, url)).rejects.toThrow();

    // Client side: the rendered 404 page is detected by the same locators the health checks use.
    await page.goto(url);
    await expect(notFoundCopy(page)).toHaveCount(1);
    await expect(notFoundHeading(page)).toHaveCount(1);
    await expect(expectNoNotFoundPage(page)).rejects.toThrow();
  });

  test("every explorer node and breadcrumb resolves", { tag: ["@regression", "@slow"] }, async ({ authedPage: page }) => {
    test.setTimeout(300_000);
    const p = paths();

    await openExplorer(page);
    await expandAll(page);
    const sidebar = page.getByTestId("left-sidebar");

    // Fixture nodes (always present) and where each must land.
    const expectedLanding: Record<string, string> = {
      enterprise: "/schemas/enterprise",
      "enterprise-entities": "/schemas/enterprise",
      [`domain-${fx.domain.id}`]: p.domain,
      [`product-${fx.product.id}`]: p.product,
      [`product-${fx.product.id}-entities`]: p.product,
      [`entity-${fx.productEntity.id}`]: p.productEntity,
      [`entity-${fx.tenantEntity.id}`]: p.tenantEntity,
    };
    const fixtureIds = Object.keys(expectedLanding);

    const allIds = await sidebar
      .locator("[data-testid]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
    // The fixture domain, product and both entity rows must really be rendered in the explorer.
    expect(allIds).toEqual(expect.arrayContaining(fixtureIds));

    // Bounded set: the fixtures, every Enterprise node, and a small sample per scope.
    const taken = new Map<string, number>();
    const sampled: string[] = [];
    for (const id of allIds) {
      const bucket = bucketOf(id);
      if (!bucket || fixtureIds.includes(id) || sampled.includes(id)) continue;
      const count = taken.get(bucket) ?? 0;
      if (bucket !== "enterprise" && count >= SAMPLE_PER_BUCKET) continue;
      taken.set(bucket, count + 1);
      sampled.push(id);
    }
    const nodeIds = [...fixtureIds, ...sampled];
    expect(nodeIds.length).toBeGreaterThanOrEqual(fixtureIds.length);

    const breadcrumbsChecked = new Set<string>();
    const urlsChecked = new Set<string>();
    const clicked: string[] = [];
    for (const id of nodeIds) {
      // Always start from /schemas: no row is active there, so `data-active`
      // flipping to true (plus the URL leaving /schemas) proves the click navigated.
      await openExplorer(page);
      await expandAll(page);
      const row = sidebar.getByTestId(id);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      clicked.push(id);

      await expect(page, `clicking ${id} did not navigate`).toHaveURL(/\/schemas\/.+/);
      await expect(row, `${id} not active after navigation`).toHaveAttribute("data-active", "true");
      await expect(row).toHaveAttribute("data-pending", "false");
      await expectNoNotFoundPage(page);
      if (expectedLanding[id]) {
        expect(new URL(page.url()).pathname, `${id} landed on the wrong URL`).toBe(expectedLanding[id]);
      }

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
      if (id === `entity-${fx.productEntity.id}`) {
        expect(crumbs.length, "the fixture entity page rendered no breadcrumbs").toBeGreaterThan(0);
      }
      for (const href of crumbs) {
        if (!href || breadcrumbsChecked.has(href)) continue;
        breadcrumbsChecked.add(href);
        await expectResolves(page.request, href, `breadcrumb on ${page.url()}`);
      }
    }

    expect(clicked).toEqual(expect.arrayContaining(fixtureIds));
    expect(breadcrumbsChecked.size, "no breadcrumb link was exercised").toBeGreaterThan(0);
    console.log(
      `sidebar click-through: ${clicked.length} nodes (${fixtureIds.length} fixture), ${urlsChecked.size} distinct URLs, ${breadcrumbsChecked.size} breadcrumb links checked`
    );
  });

  test("legacy links still land", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const p = paths();

    // `?tab=types` is the legacy alias of the `data-types` tab.
    const res = await page.goto("/schemas/enterprise?tab=types");
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByTestId("center-panel").locator("#enterprise-tab-data-types")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expectNoNotFoundPage(page);

    // Likewise for the explicit tabs.
    const entities = await page.goto("/schemas/enterprise?tab=entities");
    expect(entities?.status()).toBeLessThan(400);
    await expect(page.getByTestId("center-panel").locator("#enterprise-tab-entities")).toHaveAttribute("aria-selected", "true");

    // Legacy 2-segment entity URL: /schemas/<domain>/<entity> must land on the canonical
    // 3-segment URL. The redirect() fires after loading.tsx streamed, so it completes client-side.
    const legacy = await page.goto(`/schemas/${fx.domain.slug}/${fx.productEntity.slug}`);
    expect(legacy?.status(), "legacy 2-segment entity URL").toBeLessThan(400);
    await page.waitForURL((u) => u.pathname === p.productEntity, { timeout: 30_000 });
    await expectNoNotFoundPage(page);
    // Dev compiles the entity route on first visit and other specs load the server in parallel.
    await expect(page.getByRole("heading", { name: new RegExp(fx.productEntity.name, "i") }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("link crawl: no rendered href on workspace pages 404s", { tag: ["@regression", "@slow"] }, async ({ authedPage: page }) => {
    test.setTimeout(900_000);
    const p = paths();

    const MAX_PAGES = 200;
    const start = [
      "/schemas",
      "/schemas/enterprise",
      "/schemas/enterprise?tab=data-types",
      "/schemas/enterprise?tab=entities",
    ];
    const seen = new Set<string>();
    const queue = [...start];
    const foundOn = new Map<string, string>();

    const normalize = (href: string) => href.split("#")[0];

    while (queue.length && seen.size < MAX_PAGES) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);

      const res = await page.goto(url);
      expect(res?.status(), `broken link ${url} (found on ${foundOn.get(url) ?? "a start page"})`).toBeLessThan(400);
      await expectNoNotFoundPage(page);

      const hrefs = await page.$$eval("a[href^='/schemas']", (as) =>
        as.map((a) => a.getAttribute("href") ?? "")
      );
      for (const raw of hrefs) {
        const href = normalize(raw);
        if (!href || href.includes("/api/") || seen.has(href) || queue.includes(href)) continue;
        queue.push(href);
        foundOn.set(href, url);
      }
    }

    // A capped crawl would silently stop checking links; make that a failure.
    expect(
      queue.length,
      `crawl stopped at MAX_PAGES=${MAX_PAGES} with ${queue.length} discovered URLs unvisited; raise the cap or prune the data`
    ).toBe(0);

    // Coverage minimums: the crawl must have gone beyond its seeds and reached entity depth.
    const byDepth = [...seen].reduce<Record<number, number>>((acc, u) => {
      const depth = new URL(u, "http://x").pathname.split("/").filter(Boolean).length;
      acc[depth] = (acc[depth] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`link crawl visited ${seen.size} pages (by path depth: ${JSON.stringify(byDepth)})`);
    expect(seen.size).toBeGreaterThan(start.length);
    expect(seen.has(p.domain), `crawl never reached the fixture domain ${p.domain}`).toBe(true);
    expect(seen.has(p.product), `crawl never reached the fixture product ${p.product}`).toBe(true);
    expect(seen.has(p.productEntity), `crawl never reached the fixture entity ${p.productEntity}`).toBe(true);
    expect(seen.has(p.tenantEntity), `crawl never reached the tenant entity ${p.tenantEntity}`).toBe(true);
  });

  test("tenant-level entity is reachable from the sidebar", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const name = unique("Ent");

    try {
      await page.goto("/schemas/enterprise/new");
      await page.getByRole("button", { name: /start blank/i }).click();
      await page.getByPlaceholder("EntityName").fill(name);
      await page.getByRole("button", { name: /create entity/i }).click();
      await page.waitForURL(/\/schemas\/enterprise\/entities\//, { timeout: 60_000 });
      const entityUrl = page.url();
      await expect(page.getByRole("heading", { name: new RegExp(name, "i") }).first()).toBeVisible({
        timeout: 30_000,
      });

      // Reach it from the sidebar, starting somewhere that is not its page.
      await openExplorer(page);
      const row = page.getByTestId("left-sidebar").getByText(name, { exact: true });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await expect(page).toHaveURL(/\/schemas\/enterprise\/entities\//);
      expect(page.url()).toBe(entityUrl);
      await expectNoNotFoundPage(page);
    } finally {
      // Cleanup straight in the database, by name: it works wherever the test stopped
      // (even before the create action returned) and cannot mask the original assertion error.
      try {
        await deleteTenantEntitiesByName([name]);
      } catch (error) {
        console.warn(`cleanup of tenant entity ${name} failed: ${String(error)}`);
        test.info().annotations.push({ type: "cleanup-failed", description: `${name}: ${String(error)}` });
      }
    }
  });
});
