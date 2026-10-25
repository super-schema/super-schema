/**
 * Screenshots of a few stable pages, compared with `toHaveScreenshot`, in the `visual` project: Chromium, 1280x800, light, still, English,
 * UTC. The project exists only INSIDE the Playwright Docker image (playwright.config.ts: E2E_VISUAL_IN_DOCKER), where the snapshots were
 * made and are compared: the same page renders differently on macOS and on Linux, and a snapshot made anywhere else would fail
 * everywhere else. `npm run test:e2e:update-snapshots` makes them, `npm run test:e2e:visual` compares (docs/testing/e2e.md); the files are
 * `visual.spec.ts-snapshots/<name>-visual-linux.png`, and a unit test refuses any other.
 *
 * What makes a page the same in every run:
 *   - a tenant of its own with fixed names (`createVisualFixtures`, helpers/db.ts): "Visual Fixtures" with the domains Billing and
 *     Customers, the products Invoicing, Payments (empty) and Profiles, and the entity Customer with six fields. The viewed tenant is the
 *     `active_tenant` cookie, so the explorer, the domain grid and the governance dashboard list this and nothing else;
 *   - the tests run one after the other in one worker (the tenant's name is unique: the project is `fullyParallel: false`), after the page has settled (helpers/settle.ts: the fonts
 *     are loaded, nothing is being fetched, nothing moves) and with reduced motion, no animation and no caret (the config's defaults);
 *   - what changes by itself is masked: every date or "N minutes ago", the notification bell (its badge counts the user's unread
 *     notifications). A mask is a flat box in the snapshot, so a page that loses a date
 *     still matches, and a page that gains a block of text does not.
 *
 * The pages: login, register, the domain grid, an empty product, the entity editor, admin settings, the type mapping table, the governance
 * dashboard with nothing to decide, and the shell's 404.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/fixtures";
import { createVisualFixtures, deleteVisualFixtures, type VisualFixtures } from "./helpers/db";
import { centerPanel } from "./helpers/event-builder";
import { openEntityPage } from "./helpers/entity-page";
import { waitForHydration } from "./helpers/hydration";
import { trackInflightRequests, waitForQuietPage } from "./helpers/settle";

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "en-US",
  timezoneId: "UTC",
  contextOptions: { reducedMotion: "reduce" },
});

let fixtures: VisualFixtures | undefined;

const need = (): VisualFixtures => {
  if (!fixtures) throw new Error("the visual fixtures were not created");
  return fixtures;
};

test.beforeAll(async () => {
  fixtures = await createVisualFixtures();
});

test.afterAll(async () => {
  await deleteVisualFixtures(fixtures);
});

// Before the first page of the test: the quiet-page wait counts the requests the page has made.
test.beforeEach(async ({ page }) => {
  await trackInflightRequests(page);
});

/** A date, a time, or "N minutes ago": what a page says about when, which is never the same twice. */
const WHEN =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, \d{4})?|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|just now|\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?)\b/i;

/** The parts of a page that change by themselves. */
const volatile = (page: Page): Locator[] => [
  page.locator("time"),
  page.getByText(WHEN),
  page.getByRole("button", { name: "Notifications" }),
];

/** Open a page of the app as the admin, viewing the fixed tenant. */
async function openAsAdmin(page: Page, baseURL: string | undefined, path: string): Promise<void> {
  if (!baseURL) throw new Error("the visual specs need a baseURL");
  await page.context().addCookies([{ name: "active_tenant", value: need().tenantId, url: baseURL }]);
  await page.goto(path);
  await expect(page.getByTestId("topbar")).toBeVisible();
  await waitForHydration(page.getByTestId("topbar"));
}

/** The page, settled, against the snapshot called `name` (visual.spec.ts-snapshots/<name>-visual-linux.png). */
async function expectSnapshot(page: Page, name: string): Promise<void> {
  await waitForQuietPage(page);
  await expect(page).toHaveScreenshot(`${name}.png`, { mask: volatile(page), maskColor: "#ff00ff" });
}

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the login page", { tag: ["@regression", "@visual"] }, async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await waitForHydration(page.getByTestId("login-form"));
    await expectSnapshot(page, "login");
  });

  test("the register page", { tag: ["@regression", "@visual"] }, async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
    await waitForHydration(page.getByTestId("register-form"));
    await expectSnapshot(page, "register");
  });
});

test.describe("signed in, viewing the fixed tenant", () => {
  test("the domain grid", { tag: ["@regression", "@visual"] }, async ({ authedPage: page, baseURL }) => {
    await openAsAdmin(page, baseURL, "/schemas");
    await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    await expect(centerPanel(page).getByText("Billing", { exact: true })).toBeVisible();
    await expect(centerPanel(page).getByText("Customers", { exact: true })).toBeVisible();
    await expectSnapshot(page, "domain-grid");
  });

  test("an empty product", { tag: ["@regression", "@visual"] }, async ({ authedPage: page, baseURL }) => {
    await openAsAdmin(page, baseURL, "/schemas/billing/payments");
    await expect(centerPanel(page).getByRole("navigation", { name: "Breadcrumb" }).getByText("Payments")).toBeVisible();
    await expectSnapshot(page, "empty-product");
  });

  test("the entity editor", { tag: ["@regression", "@visual"] }, async ({ authedPage: page, baseURL }) => {
    await openAsAdmin(page, baseURL, "/schemas");
    await openEntityPage(page, need().entity.url, "Customer");
    await expect(centerPanel(page).getByRole("heading", { name: "Fields (6)" })).toBeVisible();
    await expectSnapshot(page, "entity-editor");
  });

  test("the admin settings", { tag: ["@regression", "@visual"] }, async ({ authedPage: page, baseURL }) => {
    await openAsAdmin(page, baseURL, "/admin/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
    await expectSnapshot(page, "admin-settings");
  });

  test("the type mapping table", { tag: ["@regression", "@visual"] }, async ({ authedPage: page, baseURL }) => {
    await openAsAdmin(page, baseURL, "/schemas/type-mappings");
    await expect(page.getByRole("heading", { name: "Type Mapping Reference" })).toBeVisible();
    await expectSnapshot(page, "type-mappings");
  });

  test("the governance dashboard with nothing to decide", { tag: ["@regression", "@visual"] }, async ({ authedPage: page, baseURL }) => {
    await openAsAdmin(page, baseURL, "/governance");
    await expect(page.getByRole("heading", { name: "Governance Dashboard" })).toBeVisible();
    await expectSnapshot(page, "governance-empty");
  });

  test("the shell's 404 for a page that is not there", { tag: ["@regression", "@visual"] }, async ({ authedPage: page, baseURL }) => {
    await openAsAdmin(page, baseURL, "/schemas/billing/no-such-product");
    await expect(page.getByRole("heading", { level: 1, name: "This page could not be found." })).toBeVisible();
    await expectSnapshot(page, "not-found-in-shell");
  });
});
