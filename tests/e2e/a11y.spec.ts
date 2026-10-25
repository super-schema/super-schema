/**
 * Accessibility (axe-core, WCAG 2.1 A and AA) of every route of the shell and of the states that matter most, against a recorded baseline.
 *
 * ONE TEST PER STATE (a route, a dialog, an open palette): it scans, normalizes what axe found (helpers/a11y-baseline.ts) and compares it to
 * the entries of that state in tests/e2e/a11y-baseline.json:
 *   - a violation that is not in the baseline FAILS the test (fix the page);
 *   - a baseline entry that no longer occurs FAILS it too ("remove this entry"): the baseline only shrinks.
 * `UPDATE_A11Y_BASELINE=1` rewrites the entries of the states that ran (the tests then run one after the other, one writer) instead of
 * comparing; CI never sets it. The rules, how to shrink the baseline, and what is left in it: docs/testing/a11y.md.
 *
 * The project is `a11y` (Chromium, the Google Chrome of the machine when there is one, as in playwright.config.ts). The browser asks for a
 * light scheme (`colorScheme`) and reduced motion (`reducedMotion`) so nothing depends on the machine's own settings; the app shows its
 * own default theme, DARK (src/lib/theme.tsx), which is what is scanned. Each scan waits for a quiet page first (helpers/settle.ts). The
 * scan reads the document the user sees; the AsyncAPI preview's iframe is out of it.
 *
 * States: every route of tests/e2e/fixtures/routes.ts (the page sweep's table), login and register (signed out), the shell's 404, and, in
 * a tenant made for the test (`home`), the domain and product pages, an entity page with fields, its Schemas tab, the publish dialog, the new
 * domain dialog, the command palette, and the page of an event.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test as base, expect, unique } from "./helpers/fixtures";
import { AXE_VERSION, WCAG_TAGS, scanPage, trackInflightRequests } from "./helpers/axe";
import {
  BASELINE_PATH, assertUpdateAllowed, compareToBaseline, describeComparison, entriesOfState, readBaseline, toEntries, writeBaselineState,
} from "./helpers/a11y-baseline";
import { createFieldRow, createIsolatedWorkspaceRows, deleteIsolatedWorkspaceRows } from "./helpers/db";
import { createEventFromMenu, centerPanel } from "./helpers/event-builder";
import { openEntityPage } from "./helpers/entity-page";
import { waitForHydration } from "./helpers/hydration";
import { openSchemasTab } from "./helpers/lifecycle";
import { DASHBOARD_ROUTES } from "./fixtures/routes";

/**
 * A tenant of the test's own, viewed through the `active_tenant` cookie, with a domain, a product and an entity, Customer. Every logged-in
 * state is scanned as a user of THIS tenant: the explorer, the domain grid, the compliance results and the governance dashboard list this and
 * nothing else, instead of whatever the other specs of the run have put in the default tenant at that moment (a scan of a page that lists
 * a hundred domains is not the scan of a page that lists two, and the baseline would flap with the data).
 */
interface Home {
  tenantId: string;
  domainName: string;
  domainSlug: string;
  productName: string;
  productSlug: string;
  productUrl: string;
  entities: ReadonlyArray<{ id: string; name: string; slug: string; url: string }>;
}

const test = base.extend<{ home: Home }>({
  home: [
    async ({ context, baseURL }, provide) => {
      if (!baseURL) throw new Error("the a11y spec needs a baseURL");
      const rows = await createIsolatedWorkspaceRows();
      try {
        await context.addCookies([{ name: "active_tenant", value: rows.tenantId, url: baseURL }]);
        const productUrl = `/schemas/${rows.domain.slug}/${rows.product.slug}`;
        await provide({
          tenantId: rows.tenantId,
          domainName: rows.domain.name,
          domainSlug: rows.domain.slug,
          productName: rows.product.name,
          productSlug: rows.product.slug,
          productUrl,
          entities: [{ ...rows.entity, url: `${productUrl}/${rows.entity.slug}` }],
        });
      } finally {
        await deleteIsolatedWorkspaceRows(rows);
      }
    },
    { auto: true },
  ],
});

// Refused on CI before anything runs: a pipeline must never accept its own violations.
assertUpdateAllowed(process.env);
const UPDATE = process.env.UPDATE_A11Y_BASELINE === "1";
const OBSERVED_DIR = path.resolve(__dirname, "../../test-results/a11y-observed");

// Updating rewrites one file from every state: one writer at a time.
if (UPDATE) test.describe.configure({ mode: "serial" });

test.use({ colorScheme: "light", contextOptions: { reducedMotion: "reduce" } });

// Before the first page of the test is loaded: a scan waits for the requests the page has made (a list being fetched is not a settled page).
test.beforeEach(async ({ page }) => {
  await trackInflightRequests(page);
});

/** Every state this spec scans, by id (what the baseline is keyed by); the last test checks the baseline names none other. */
const ROUTE_STATES = DASHBOARD_ROUTES.map((route) => `route:${route.path}`);
const WORKSPACE_STATES = [
  "page:domain",
  "page:product",
  "page:entity",
  "tab:entity-schemas",
  "dialog:entity-publish",
  "dialog:domain-create",
  "overlay:command-palette",
  "page:event",
  "page:not-found-in-shell",
] as const;
const SIGNED_OUT_STATES = ["page:login", "page:register"] as const;
const ALL_STATES: readonly string[] = [...ROUTE_STATES, ...WORKSPACE_STATES, ...SIGNED_OUT_STATES];

/** Scan the page now and compare (or, when updating, record) the result for `state`. */
async function checkState(page: Page, state: string, names: Readonly<Record<string, string>> = {}): Promise<void> {
  const findings = await scanPage(page);
  const found = toEntries(state, findings, names);
  if (UPDATE) {
    writeBaselineState(state, found, { axe: AXE_VERSION, tags: WCAG_TAGS });
    // What axe saw, in full (the element's HTML, the rule's help), for whoever works on shrinking the baseline: test-results/ is not committed.
    mkdirSync(OBSERVED_DIR, { recursive: true });
    writeFileSync(path.join(OBSERVED_DIR, `${state.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(findings, null, 2));
    return;
  }
  const comparison = compareToBaseline(entriesOfState(readBaseline(), state), found);
  expect(comparison.added.length + comparison.removed.length, describeComparison(state, comparison, findings)).toBe(0);
}

test.describe("routes", () => {
  for (const route of DASHBOARD_ROUTES) {
    test(`${route.path} (${route.name})`, { tag: ["@regression"] }, async ({ authedPage: page }) => {
      await page.goto(route.path);
      await expect(page.getByRole("heading", { name: route.heading, exact: true, level: route.level })).toBeVisible();
      await checkState(page, `route:${route.path}`);
    });
  }
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the login page", { tag: ["@regression"] }, async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await waitForHydration(page.getByTestId("login-form"));
    await checkState(page, "page:login");
  });

  test("the register page", { tag: ["@regression"] }, async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
    await waitForHydration(page.getByTestId("register-form"));
    await checkState(page, "page:register");
  });
});

test.describe("a workspace", () => {
  /** The names the workspace makes up, as placeholders, so a selector that carries one is the same in every run. */
  const namesOf = (home: Home, more: Record<string, string> = {}) => ({
    [home.domainSlug]: "<domain>",
    [home.productSlug]: "<product>",
    [home.entities[0].id]: "<entity>",
    ...more,
  });

  test("the domain page", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await page.goto(`/schemas/${home.domainSlug}`);
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: home.domainName })).toBeVisible();
    await checkState(page, "page:domain", namesOf(home));
  });

  test("the product page", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await page.goto(home.productUrl);
    await expect(centerPanel(page).getByRole("navigation", { name: "Breadcrumb" }).getByText(home.productName)).toBeVisible();
    await checkState(page, "page:product", namesOf(home));
  });

  test("an entity page with fields", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    const customer = home.entities[0];
    await createFieldRow(customer.id, { name: "email", type: "string", classification: "PII", sortOrder: 1 });
    await createFieldRow(customer.id, { name: "age", type: "integer", sortOrder: 2 });
    await createFieldRow(customer.id, { name: "active", type: "boolean", sortOrder: 3 });
    await openEntityPage(page, customer.url, "Customer");
    await expect(centerPanel(page).getByRole("heading", { name: "Fields (4)" })).toBeVisible();
    await checkState(page, "page:entity", namesOf(home));
  });

  test("the Schemas tab of an entity", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await openEntityPage(page, home.entities[0].url, "Customer");
    await openSchemasTab(page);
    await checkState(page, "tab:entity-schemas", namesOf(home));
  });

  test("the publish dialog of an entity", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await openEntityPage(page, home.entities[0].url, "Customer");
    await centerPanel(page).getByTestId("publish-entity-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("confirm-publish")).toBeVisible();
    await checkState(page, "dialog:entity-publish", namesOf(home));
  });

  test("the new domain dialog", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await page.goto("/schemas");
    await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    const newDomainButton = centerPanel(page).getByTestId("create-domain-button");
    await waitForHydration(newDomainButton);
    await newDomainButton.click();
    await expect(page.getByTestId("create-domain-form")).toBeVisible();
    await checkState(page, "dialog:domain-create");
  });

  test("the command palette", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await page.goto("/schemas");
    await waitForHydration(page.getByTestId("topbar"));
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByPlaceholder("Search entities, fields, actions...")).toBeVisible();
    await checkState(page, "overlay:command-palette");
  });

  test("the page of an event (the builder)", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    const name = unique("A11yEvent");
    const id = await createEventFromMenu(page, home.productUrl, name);
    await checkState(page, "page:event", namesOf(home, { [id]: "<event>", [name]: "<event-name>" }));
  });

  test("the shell's 404: a page that is not there", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await page.goto(`/schemas/${home.domainSlug}/${unique("no-such-product-")}`);
    await expect(page.getByTestId("topbar")).toBeVisible();
    await checkState(page, "page:not-found-in-shell", namesOf(home));
  });
});

test.describe("the baseline", () => {
  test("names only states this spec scans, with sorted unique entries (the baseline only shrinks: an entry of a state that is gone is removed with it)", { tag: ["@regression"] }, async () => {
    if (UPDATE) return; // UPDATE_A11Y_BASELINE=1 is rewriting the file: nothing to check yet
    const baseline = readBaseline();
    expect(baseline.tags, "the tags of the scan").toEqual([...WCAG_TAGS]);
    const known = new Set(ALL_STATES);
    const unknown = [...new Set(baseline.violations.map((entry) => entry.state))].filter((state) => !known.has(state));
    expect(unknown, `${BASELINE_PATH}: entries of states that this spec does not scan (remove them)`).toEqual([]);
    const keys = baseline.violations.map((entry) => `${entry.state}|${entry.rule}|${entry.target}`);
    expect(new Set(keys).size, "an entry is listed twice").toBe(keys.length);
  });
});
