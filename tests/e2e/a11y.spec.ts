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
import {
  createFieldRow, createInvitationRow, createIsolatedWorkspaceRows, createUserRow, createUserWithPassword, deleteIsolatedWorkspaceRows, deleteInvitationsByEmail, deleteUsersByEmail,
  disableUser, grantScopedRoleRow, seededOwnerId,
} from "./helpers/db";
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
/** The Admin Users screen's own states (a person to open, the dialogs and the panel), in a tenant of the test's own. */
const ADMIN_STATES = [
  "dialog:admin-invite",
  "dialog:admin-invite-link",
  "panel:admin-user",
  "dialog:admin-user-status",
  "dialog:admin-reset-link",
  "page:admin-role-matrix",
  "page:admin-no-permission",
  "page:admin-user-statuses",
] as const;
const SIGNED_OUT_STATES = ["page:login", "page:register"] as const;
const ALL_STATES: readonly string[] = [...ROUTE_STATES, ...WORKSPACE_STATES, ...ADMIN_STATES, ...SIGNED_OUT_STATES];

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

test.describe("the Admin Users screen", () => {
  /** Accounts and invitations the tests made; removed afterwards (nothing here acts as them, so nothing pins them). */
  const people: string[] = [];
  const invitations: string[] = [];

  test.afterAll(async () => {
    try {
      await deleteInvitationsByEmail(invitations);
      await deleteUsersByEmail(people);
    } catch (error) {
      console.warn(`a11y.spec admin cleanup failed: ${String(error)}`);
    }
  });

  /** A person with a role in the test's tenant (so the list has a row to open), and the Users screen open and interactive. */
  async function openUsersWithPerson(page: Page, home: Home): Promise<string> {
    const email = `${unique("e2e-a11y-person-")}@example.com`.toLowerCase();
    people.push(email);
    const { id } = await createUserRow({ email, name: "A11y Person" });
    await grantScopedRoleRow(id, "AUTHOR", { tenantId: home.tenantId });
    await page.goto("/admin");
    await expect(centerPanel(page).getByRole("heading", { name: "Users", level: 2 })).toBeVisible();
    await expect(centerPanel(page).getByText("Loading users…")).toHaveCount(0);
    await waitForHydration(centerPanel(page).getByTestId("invite-user-open"));
    await centerPanel(page).getByTestId("user-filter").fill(email);
    await expect(centerPanel(page).locator(`[data-testid="user-row"][data-email="${email}"]`)).toBeVisible();
    return email;
  }

  test("the invitation dialog", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await openUsersWithPerson(page, home);
    await centerPanel(page).getByTestId("invite-user-open").click();
    const dialog = page.getByTestId("invite-user-dialog");
    await expect(dialog.getByTestId("scope-tenant")).toBeVisible();
    await checkState(page, "dialog:admin-invite");
  });

  test("the invitation dialog showing the one-time link", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await openUsersWithPerson(page, home);
    const email = `${unique("e2e-a11y-invitee-")}@example.com`.toLowerCase();
    invitations.push(email);
    await centerPanel(page).getByTestId("invite-user-open").click();
    const dialog = page.getByTestId("invite-user-dialog");
    await dialog.getByLabel("Email address").fill(email);
    await dialog.getByTestId("scope-tenant").selectOption(home.tenantId);
    await dialog.getByTestId("invite-submit").click();
    await expect(dialog.getByTestId("invite-link")).toBeVisible({ timeout: 30_000 });
    await checkState(page, "dialog:admin-invite-link");
  });

  test("a person's panel", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    const email = await openUsersWithPerson(page, home);
    await centerPanel(page).locator(`[data-testid="user-row"][data-email="${email}"]`).click();
    await expect(centerPanel(page).getByTestId("user-detail-panel")).toHaveAttribute("data-email", email);
    await checkState(page, "panel:admin-user");
  });

  test("the disable confirmation", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    const email = await openUsersWithPerson(page, home);
    await centerPanel(page).locator(`[data-testid="user-row"][data-email="${email}"]`).click();
    await centerPanel(page).getByTestId("user-status-toggle").click();
    await expect(page.getByTestId("user-status-dialog")).toBeVisible();
    await checkState(page, "dialog:admin-user-status");
  });

  test("the reset link dialog", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    const email = await openUsersWithPerson(page, home);
    await centerPanel(page).locator(`[data-testid="user-row"][data-email="${email}"]`).click();
    await centerPanel(page).getByTestId("user-reset-link").click();
    await expect(page.getByTestId("reset-create")).toBeVisible();
    await checkState(page, "dialog:admin-reset-link");
  });

  // The Disabled badge, the Invited badge and the Revoke button only exist next to a disabled account and a pending invitation: this is the state that shows them, so
  // their colours (the badge's outline, the button's text, on the dark theme the app opens in) are measured and not reasoned about.
  test("the users table with a disabled account and a pending invitation (the Disabled and Invited badges, the Revoke button)", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    const stem = "e2e-a11y-status-";
    const disabledEmail = `${unique(stem)}@example.com`.toLowerCase();
    const invitedEmail = `${unique(stem)}@example.com`.toLowerCase();
    people.push(disabledEmail);
    invitations.push(invitedEmail);
    const { id } = await createUserRow({ email: disabledEmail, name: "A11y Disabled" });
    await grantScopedRoleRow(id, "AUTHOR", { tenantId: home.tenantId });
    await disableUser(id);
    await createInvitationRow({ email: invitedEmail, createdById: await seededOwnerId(), roles: [{ role: "VIEWER", scopeKey: `T:${home.tenantId}` }] });

    await page.goto("/admin");
    await expect(centerPanel(page).getByRole("heading", { name: "Users", level: 2 })).toBeVisible();
    await expect(centerPanel(page).getByText("Loading users…")).toHaveCount(0);
    await waitForHydration(centerPanel(page).getByTestId("invite-user-open"));
    // Both rows, and nothing else of the database's users (the filter matches the shared start of the two addresses).
    await centerPanel(page).getByTestId("user-filter").fill(stem);
    const disabledRow = centerPanel(page).locator(`[data-testid="user-row"][data-email="${disabledEmail}"]`);
    const invitedRow = centerPanel(page).locator(`[data-testid="invitation-row"][data-email="${invitedEmail}"]`);
    await expect(disabledRow.getByTestId("user-status")).toHaveAttribute("data-status", "disabled");
    await expect(invitedRow.getByTestId("user-status")).toHaveAttribute("data-status", "invited");
    await expect(invitedRow.getByTestId("invitation-revoke")).toBeVisible();
    await checkState(page, "page:admin-user-statuses", { [disabledEmail]: "<disabled-user>", [invitedEmail]: "<invited-user>" });
  });

  test("the role matrix", { tag: ["@regression"] }, async ({ authedPage: page, home }) => {
    await openUsersWithPerson(page, home);
    await centerPanel(page).getByTestId("admin-view-matrix").click();
    await expect(centerPanel(page).getByTestId("role-matrix-table")).toBeVisible();
    await checkState(page, "page:admin-role-matrix");
  });

  test("the no-permission screen (an AUTHOR on /admin)", { tag: ["@regression"] }, async ({ browser, baseURL, home }) => {
    if (!baseURL) throw new Error("the a11y spec needs a baseURL");
    const email = `${unique("e2e-a11y-author-")}@example.com`.toLowerCase();
    people.push(email);
    const { id } = await createUserWithPassword({ email, password: "tangerine-lantern-orbit-42" });
    await grantScopedRoleRow(id, "AUTHOR", { tenantId: home.tenantId });
    const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, colorScheme: "light", reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await trackInflightRequests(page);
      await page.goto("/login");
      await waitForHydration(page.getByTestId("login-form"));
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill("tangerine-lantern-orbit-42");
      await page.getByTestId("login-submit").click();
      await expect(page).toHaveURL((url) => url.pathname === "/schemas", { timeout: 60_000 });
      await page.goto("/admin");
      await expect(page.getByTestId("admin-no-permission")).toBeVisible();
      await checkState(page, "page:admin-no-permission");
    } finally {
      await context.close();
    }
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
