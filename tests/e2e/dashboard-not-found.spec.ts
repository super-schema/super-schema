/**
 * Dashboard not-found E2E (final review F6): a `notFound()` under the dashboard renders `(dashboard)/not-found.tsx`
 * INSIDE the dashboard shell, so the top bar, the organization switcher and the explorer stay available and the user can
 * navigate away. Before F6 an unknown asset URL replaced the whole screen with Next's bare 404.
 *
 * Two real "unknown asset" routes are visited as the logged-in admin: an unknown domain slug, and an unknown Enterprise
 * trait. Neither needs a fixture (the ids are unique and cannot exist), so the spec writes nothing to the database.
 *
 * PREREQS: see helpers/auth.ts (seeded admin, running dev server). The first visit of each route compiles in dev, so the
 * timeouts below are generous.
 */

import type { Page } from "@playwright/test";
import { test, expect, unique } from "./helpers/fixtures";
import { leftSidebar } from "./helpers/event-builder";

const NOT_FOUND_COPY = "This page could not be found";

/** The not-found page is rendered, once, in the center panel, with the dashboard shell around it. */
async function expectNotFoundInsideShell(page: Page) {
  const centerPanel = page.getByTestId("center-panel");
  const notFound = page.getByTestId("dashboard-not-found");

  // The page itself: one h1 with the standard copy (navigation.spec.ts detects a 404 by this heading and copy).
  await expect(notFound).toBeVisible();
  await expect(centerPanel.getByTestId("dashboard-not-found"), "the 404 renders in the center panel, not instead of the shell").toBeVisible();
  await expect(page.getByRole("heading", { name: `${NOT_FOUND_COPY}.` })).toHaveCount(1);
  await expect(page.locator("h1.next-error-h1")).toHaveCount(1);
  await expect(page.getByText(NOT_FOUND_COPY)).toHaveCount(1);

  // The shell around it: top bar, organization switcher, and the loaded explorer (the skeleton has no "enterprise" row).
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page.getByTestId("tenant-switcher")).toBeVisible();
  await expect(leftSidebar(page).getByTestId("enterprise")).toBeVisible({ timeout: 30_000 });
}

/** The switcher is live, not just painted: it opens and lists the organizations. */
async function expectTenantSwitcherOpens(page: Page) {
  await page.getByTestId("tenant-switcher").click();
  await expect(page.getByText("Organizations", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Organizations", { exact: true })).toHaveCount(0);
}

/** The way out: "Domains" leads to the domain list, and the 404 is gone. */
async function expectLinkBackToDomains(page: Page) {
  const domainsLink = page.getByRole("navigation", { name: "Where to go next" }).getByRole("link", { name: "Domains" });
  await expect(domainsLink).toBeVisible();
  await expect(domainsLink).toHaveAttribute("href", "/schemas");
  await domainsLink.click();

  await expect(page).toHaveURL(/\/schemas$/);
  await expect(page.getByRole("heading", { name: "Domains" })).toBeVisible();
  await expect(page.getByTestId("dashboard-not-found")).toHaveCount(0);
  await expect(page.getByTestId("topbar")).toBeVisible();
}

test.describe("dashboard not-found inside the shell", () => {
  test("an unknown domain slug renders the 404 inside the shell, with a working way back to Domains", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    test.setTimeout(180_000);

    await page.goto(`/schemas/zzz-nope-${unique("dom-")}`);

    await expectNotFoundInsideShell(page);
    await expectTenantSwitcherOpens(page);
    await expectLinkBackToDomains(page);
  });

  test("an unknown Enterprise trait renders the 404 inside the shell, with a working way back to Domains", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    test.setTimeout(180_000);

    await page.goto("/schemas/enterprise/traits/does-not-exist");

    await expectNotFoundInsideShell(page);
    await expectTenantSwitcherOpens(page);
    await expectLinkBackToDomains(page);
  });
});
