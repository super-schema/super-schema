/**
 * Finding things and moving around: the command palette, the keyboard shortcuts, the tenant switcher, the notification bell and the
 * notification history.
 *
 * What each does (each line is a test):
 *   - Command palette  Mod+K opens it and toggles it, Esc closes it (from the search box too), the backdrop closes it; typing the name of
 *                      an entity (or its domain's) finds it and Enter opens it; a field is found as `Entity -> field` and opens its
 *                      studio; "Go to Domains" and the actions list the shortcuts; an entity opened from it is under "Recent".
 *   - Shortcuts        `/` opens the new-field form of an entity page (not while typing in an input, Esc closes it), Mod+N opens the new
 *                      entity wizard of the product being viewed (the palette, to choose one, where there is no product), Mod+S says "All
 *                      changes saved" in the status bar, Mod+E emits the entity (a toast with the targets), Mod+S in the field studio
 *                      saves the field.
 *   - Tenant switcher  lists the tenants with their domain counts; choosing another shows ITS domains in the explorer and the Domains page
 *                      and none of the first tenant's; choosing the first again brings them back.
 *   - Notification bell  the unread count (9+ above nine), the list, Mark all as read (kept after a reload), opening a notification goes to
 *                      its entity and marks it read (kept), an empty mailbox says so. The user of each test is a user of its own
 *                      (registered through the UI): a notification belongs to a user, so the admin's mailbox is not shared.
 *   - Notification history  `/notifications`: type and status filters, 25 rows to a page, Previous / Next and the page boundary
 *                      (KD-019: Next is enabled on a last page that is exactly full).
 *
 * NOT AVAILABLE IN THE UI (nothing was invented for it): marking one notification read or unread from the history page (only the bell's
 * click and Mark all as read), deleting a notification, a notification preference page, searching the palette for a domain by name (the
 * domain's ENTITIES are found by it, and "Go to Domains" is the one domain entry), Esc discarding an edit in the field list (the entity
 * workspace's handler needs a form that registers itself dirty; none does on the page).
 *
 * `/api/command-palette-fields` returns the first 100 fields of the database (all tenants, by entity name: KD-020), so the field test
 * names its entity to sort first. Mod is Control or Meta (`ControlOrMeta`): the app asks the browser's platform.
 */
import type { Locator, Page } from "@playwright/test";
import {
  createEntityInTenant,
  createFieldRow,
  createNotifications,
  createSecondTenant,
  deleteTenantWithDomain,
  disconnectDb,
  notificationReadFlags,
  pg,
} from "./helpers/db";
import { centerPanel, leaveForm, leftSidebar } from "./helpers/event-builder";
import { test, expect, unique } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";
import { withSecondUser, type SecondUser } from "./helpers/second-user";

const MOD = "ControlOrMeta";

test.afterAll(async () => {
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

const paletteInput = (page: Page): Locator => page.getByPlaceholder("Search entities, fields, actions...");
const paletteOption = (page: Page, name: string | RegExp): Locator => page.getByRole("option", { name });
/** An entity's entry ("Entity", then its domain): the entry of one of its fields reads "Entity -> field" and is another option. */
const entityOption = (page: Page, entity: string, domain: string): Locator => paletteOption(page, new RegExp(`^${entity}\\s+${domain}$`));

/** A page of the dashboard whose shell has been hydrated (the shortcut listeners are attached then). */
async function openDashboard(page: Page, path = "/schemas"): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("topbar")).toBeVisible();
  await waitForHydration(page.getByTestId("topbar"));
}

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+k`);
  await expect(paletteInput(page)).toBeVisible();
  await expect(paletteInput(page)).toBeFocused();
}

test.describe("command palette: entities", () => {
  const entityName = unique("PaletteEnt");
  test.use({ workspaceEntities: [entityName] });

  test("Mod+K opens the palette, a search for an entity's name finds it and Enter opens it", { tag: ["@smoke", "@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDashboard(page);
    await openPalette(page);

    await paletteInput(page).fill(entityName);
    await expect(entityOption(page, entityName, workspace.domainName)).toBeVisible();
    // The first entry is the entity (its fields come after it): Enter opens it.
    await expect(entityOption(page, entityName, workspace.domainName)).toHaveAttribute("aria-selected", "true");
    await paletteInput(page).press("Enter");

    await expect(page).toHaveURL(new RegExp(`/schemas/${workspace.domainSlug}/${workspace.productSlug}/${workspace.entities[0].slug}$`));
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: entityName })).toBeVisible();
    await expect(paletteInput(page)).toHaveCount(0);
  });

  test("typing the domain's name finds the entities in it, and a name nothing has says 'No results found.'", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDashboard(page);
    await openPalette(page);

    await paletteInput(page).fill(workspace.domainName);
    await expect(entityOption(page, entityName, workspace.domainName)).toBeVisible();

    await paletteInput(page).fill("no-entity-field-or-action-has-this-text-xyz");
    await expect(page.getByText("No results found.")).toBeVisible();
    await expect(paletteOption(page, /./)).toHaveCount(0);
  });

  test("an entity opened from the palette is listed under Recent the next time it opens", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await openDashboard(page);
    await openPalette(page);
    await paletteInput(page).fill(entityName);
    await entityOption(page, entityName, workspace.domainName).click();
    await expect(page).toHaveURL(new RegExp(`/${workspace.entities[0].slug}$`));

    await openPalette(page);
    const recent = page.getByRole("group", { name: "Recent" });
    await expect(recent).toBeVisible();
    await expect(recent.getByRole("option", { name: new RegExp(`^${entityName}\\s+${workspace.domainName}$`) })).toBeVisible();
  });
});

test.describe("command palette: fields", () => {
  // The palette is given the first 100 fields by entity name (KD-020): a name that sorts before letters keeps this entity among them.
  const entityName = `0${unique("pal")}`;
  test.use({ workspaceEntities: [entityName] });

  test("a field is found as 'Entity → field' and opens its studio", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const entity = workspace.entities[0];
    await createFieldRow(entity.id, { name: "palette_probe", type: "int32" });
    await openDashboard(page);
    await openPalette(page);

    await paletteInput(page).fill("palette_probe");
    const option = paletteOption(page, new RegExp(`${entityName}.*palette_probe`));
    await expect(option).toBeVisible();
    await expect(option).toContainText("int32");
    await option.click();

    await expect(page).toHaveURL(new RegExp(`/schemas/${workspace.domainSlug}/${workspace.productSlug}/${entity.slug}/fields/`));
  });

  test("the palette is offered the fields of the tenant being viewed, and none of another tenant", { tag: ["@regression"] }, async ({ request, workspace }) => {
    const other = await createSecondTenant();
    try {
      // Named to sort before letters too: before the tenant filter it was inside the first 100 fields every tenant's palette was given.
      const awayName = `0${unique("away")}`;
      await createEntityInTenant(other.tenantId, awayName);

      const response = await request.get("/api/command-palette-fields");
      expect(response.status()).toBe(200);
      const entityNames = new Set(((await response.json()) as Array<{ entityName: string }>).map((field) => field.entityName));
      // The answer has this tenant's own entity (the workspace's), so the absence of the other's means something.
      expect(entityNames.has(workspace.entities[0].name)).toBe(true);
      expect(entityNames.has(awayName)).toBe(false);
    } finally {
      await deleteTenantWithDomain(other);
    }
  });
});

test.describe("command palette: closing and actions", () => {
  test("Mod+K toggles it, Esc closes it from the search box, and so does a click on the backdrop; it reopens empty", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    await openDashboard(page);

    await openPalette(page);
    await page.keyboard.press(`${MOD}+k`);
    await expect(paletteInput(page)).toHaveCount(0);

    await openPalette(page);
    await paletteInput(page).fill("something typed");
    await page.keyboard.press("Escape");
    await expect(paletteInput(page)).toHaveCount(0);

    await openPalette(page);
    await expect(paletteInput(page)).toHaveValue("");
    await page.mouse.click(5, 5);
    await expect(paletteInput(page)).toHaveCount(0);

    // The search field of the top bar opens it too.
    await page.getByTestId("topbar").getByRole("button", { name: /^Search or press/ }).click();
    await expect(paletteInput(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(paletteInput(page)).toHaveCount(0);
  });

  test("the actions are listed with their shortcuts, and 'Go to Domains' goes to the domains", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openDashboard(page, "/glossary");
    await openPalette(page);

    const actions = page.getByRole("group", { name: "Actions" });
    for (const [label, shortcut] of [
      ["New Entity", "N"],
      ["Save", "S"],
      ["Emit TypeSpec", "E"],
    ] as const) {
      await expect(actions.getByRole("option", { name: new RegExp(`^${label}`) })).toContainText(new RegExp(`(Ctrl|⌘)\\+${shortcut}$`));
    }
    await expect(actions.getByRole("option", { name: "Show Diff" })).toBeVisible();
    await expect(actions.getByRole("option", { name: "Export" })).toBeVisible();

    await actions.getByRole("option", { name: "Go to Domains" }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/schemas");
    await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    await expect(paletteInput(page)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

test.describe("keyboard shortcuts", () => {
  const entityName = unique("ShortcutEnt");
  test.use({ workspaceEntities: [entityName] });

  test("'/' opens the new-field form on an entity page, not while typing in an input, and Esc closes it", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDashboard(page, workspace.entities[0].url);
    await expect(centerPanel(page).getByRole("heading", { name: /^Fields \(\d+\)$/ })).toBeVisible();
    const form = centerPanel(page).getByTestId("new-field-form");
    await expect(form).toHaveCount(0);

    // Typing a slash in a text box is typing: the search box of the explorer takes it.
    await leftSidebar(page).getByPlaceholder("Filter domains, entities...").fill("a/b");
    await expect(form).toHaveCount(0);
    await leftSidebar(page).getByPlaceholder("Filter domains, entities...").fill("");
    await leaveForm(page);

    await page.keyboard.press("/");
    await expect(form).toBeVisible();
    await expect(form.getByPlaceholder("field_name")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
  });

  test("Mod+N opens the new entity wizard of the product being viewed, and the palette where there is no product", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDashboard(page, workspace.productUrl);
    await expect(centerPanel(page).getByRole("tab", { name: "Entities" })).toBeVisible();
    await page.keyboard.press(`${MOD}+n`);
    await expect(page).toHaveURL(`${new URL(page.url()).origin}${workspace.productUrl}/new`);
    await expect(centerPanel(page).getByRole("heading", { name: /create new entity/i })).toBeVisible();

    // From an entity page (the product's too).
    await openDashboard(page, workspace.entities[0].url);
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: entityName })).toBeVisible();
    await page.keyboard.press(`${MOD}+n`);
    await expect(page).toHaveURL(new RegExp(`${workspace.productUrl}/new$`));

    // Where no product is being viewed, the palette opens so that a target can be chosen.
    await openDashboard(page, "/schemas");
    await page.keyboard.press(`${MOD}+n`);
    await expect(paletteInput(page)).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/schemas");
  });

  test("Mod+S says 'All changes saved' in the status bar for a moment, from the shortcut and from the palette action", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDashboard(page, workspace.entities[0].url);
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: entityName })).toBeVisible();
    const flash = page.getByTestId("status-bar").getByTestId("save-flash");
    await expect(flash).toHaveCount(0);

    await page.keyboard.press(`${MOD}+s`);
    await expect(flash).toHaveText("All changes saved");
    // It goes after about two seconds.
    await expect(flash).toHaveCount(0, { timeout: 10_000 });

    await openPalette(page);
    await paletteInput(page).fill("Save");
    await paletteOption(page, /^Save/).click();
    await expect(flash).toHaveText("All changes saved");
  });

  test("Mod+E emits the entity: a toast says how many targets were generated", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await openDashboard(page, workspace.entities[0].url);
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: entityName })).toBeVisible();

    await page.keyboard.press(`${MOD}+e`);
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: /^Emitted to \d+ targets?/ });
    await expect(toast).toBeVisible({ timeout: 45_000 });
    // "Emission failed: N targets invalid" is the other thing a toast of an emit can say: that would be a failure of this test.
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /Emission failed/ })).toHaveCount(0);
  });

  test("Mod+S in the field studio saves the field being edited, and the studio says Saved", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const entity = workspace.entities[0];
    const { id: fieldId } = await createFieldRow(entity.id, { name: "studio_probe" });
    await openDashboard(page, `${entity.url}/fields/${fieldId}`);
    const name = centerPanel(page).getByTestId("field-studio-name");
    await expect(name).toHaveValue("studio_probe");
    await waitForHydration(name);

    await name.fill("studio_renamed");
    await page.keyboard.press(`${MOD}+s`);

    await expect(centerPanel(page).getByTestId("field-studio-save-status")).toHaveAttribute("data-status", "saved");
    await expect.poll(async () => (await pg().query(`SELECT name FROM fields WHERE id = $1`, [fieldId])).rows[0]?.name as string).toBe("studio_renamed");
  });
});

// ---------------------------------------------------------------------------
// Tenant switcher
// ---------------------------------------------------------------------------

const switcher = (page: Page): Locator => page.getByTestId("tenant-switcher");
const tenantOption = (page: Page, tenantId: string): Locator => page.locator(`[data-testid="tenant-option"][data-tenant-id="${tenantId}"]`);
const explorerDomain = (page: Page, name: string): Locator => leftSidebar(page).locator('[data-testid^="domain-"]').filter({ hasText: name });

test.describe("tenant switcher", () => {
  test("it names the tenant being viewed and lists the tenants with their domain counts", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const other = await createSecondTenant();
    try {
      await openDashboard(page);
      await expect(switcher(page)).toContainText("Default Tenant");
      await switcher(page).click();
      await expect(page.getByText("Organizations", { exact: true })).toBeVisible();

      await expect(tenantOption(page, other.tenantId)).toContainText(other.tenantName);
      await expect(tenantOption(page, other.tenantId)).toContainText("1");
      await expect(tenantOption(page, other.tenantId)).toHaveAttribute("data-active", "false");
      const active = page.locator('[data-testid="tenant-option"][data-active="true"]');
      await expect(active).toHaveCount(1);
      await expect(active).toContainText("Default Tenant");
    } finally {
      await deleteTenantWithDomain(other);
    }
  });

  test("choosing another tenant shows its domains in the explorer and on the Domains page, and none of the first tenant's; choosing the first brings them back", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const other = await createSecondTenant();
    try {
      await openDashboard(page);
      await expect(explorerDomain(page, workspace.domainName)).toBeVisible();
      await expect(explorerDomain(page, other.domainName)).toHaveCount(0);

      await switcher(page).click();
      await tenantOption(page, other.tenantId).click();

      await expect(switcher(page)).toContainText(other.tenantName);
      await expect(explorerDomain(page, other.domainName)).toBeVisible();
      await expect(explorerDomain(page, workspace.domainName)).toHaveCount(0);
      await expect(explorerDomain(page, "Public")).toHaveCount(0);

      // The Domains page follows: a hard load keeps the choice (it is a cookie).
      await page.goto("/schemas");
      await expect(centerPanel(page).getByText(other.domainName).first()).toBeVisible();
      await expect(centerPanel(page).getByText(workspace.domainName)).toHaveCount(0);
      await expect(switcher(page)).toContainText(other.tenantName);

      await switcher(page).click();
      await page.locator('[data-testid="tenant-option"]').filter({ hasText: "Default Tenant" }).click();
      await expect(switcher(page)).toContainText("Default Tenant");
      await expect(explorerDomain(page, workspace.domainName)).toBeVisible();
      await expect(explorerDomain(page, other.domainName)).toHaveCount(0);
    } finally {
      await deleteTenantWithDomain(other);
    }
  });
});

// ---------------------------------------------------------------------------
// Notification bell
// ---------------------------------------------------------------------------

const bell = (page: Page): Locator => page.getByTestId("notification-bell");
const badge = (page: Page): Locator => page.getByTestId("notification-badge");
const bellItems = (page: Page): Locator => page.getByTestId("notification-list").locator('[data-testid^="notification-item-"]');

/** The signed-in user's dashboard, loaded after their notifications were written. */
async function openAs(user: SecondUser, path = "/schemas"): Promise<Page> {
  await openDashboard(user.page, path);
  return user.page;
}

test.describe("notification bell", () => {
  test("a user with no notifications sees no badge, and an empty list that says so", { tag: ["@regression"] }, async ({ browser, baseURL }) => {
    await withSecondUser(browser, baseURL, async (user) => {
      const page = await openAs(user);
      await expect(bell(page)).toBeVisible();
      await expect(bell(page)).toHaveAttribute("aria-label", "Notifications");
      await expect(badge(page)).toHaveCount(0);

      await bell(page).click();
      await expect(page.getByTestId("empty-state")).toHaveText("All caught up — no pending actions");
      await expect(page.getByTestId("mark-all-read")).toHaveCount(0);

      await page.getByRole("link", { name: "View All" }).click();
      await expect(page).toHaveURL((url) => url.pathname === "/notifications");
      await expect(page.getByRole("heading", { name: "Notification History", level: 1 })).toBeVisible();
      await expect(page.getByText("No notifications found.")).toBeVisible();
    });
  });

  test("the badge counts the unread notifications, the list shows them all, and Mark all as read clears it for good", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    await withSecondUser(browser, baseURL, async (user) => {
      const titles = { a: unique("Unread A "), b: unique("Unread B "), c: unique("Unread C "), done: unique("Already read ") };
      await createNotifications(user.id, [
        { title: titles.a, type: "DRIFT_ALERT", minutesAgo: 1 },
        { title: titles.b, type: "COMPLIANCE_GAP", minutesAgo: 2 },
        { title: titles.c, type: "CHANGE_COMPLETE", minutesAgo: 3 },
        { title: titles.done, type: "CHANGE_COMPLETE", read: true, minutesAgo: 4 },
      ]);
      const page = await openAs(user);

      await expect(badge(page)).toHaveText("3");
      await expect(bell(page)).toHaveAttribute("aria-label", "Notifications (3 unread)");

      await bell(page).click();
      await expect(bellItems(page)).toHaveCount(4);
      await expect(page.getByTestId("notification-list").getByText(titles.a)).toBeVisible();
      await expect(page.getByTestId("notification-list").getByText(titles.done)).toBeVisible();
      await expect(page.getByTestId("unread-indicator")).toHaveCount(3);

      await page.getByTestId("mark-all-read").click();
      await expect(badge(page)).toHaveCount(0);
      await expect(page.getByTestId("unread-indicator")).toHaveCount(0);
      await expect(page.getByTestId("mark-all-read")).toHaveCount(0);
      await expect.poll(async () => Object.values(await notificationReadFlags(user.id))).toEqual([true, true, true, true]);

      await openDashboard(page);
      await expect(bell(page)).toHaveAttribute("aria-label", "Notifications");
      await expect(badge(page)).toHaveCount(0);
    });
  });

  test("more than nine unread reads 9+", { tag: ["@regression"] }, async ({ browser, baseURL }) => {
    await withSecondUser(browser, baseURL, async (user) => {
      await createNotifications(
        user.id,
        Array.from({ length: 12 }, (_, i) => ({ title: unique(`Many ${i} `), minutesAgo: i })),
      );
      const page = await openAs(user);
      await expect(badge(page)).toHaveText("9+");
      await expect(bell(page)).toHaveAttribute("aria-label", "Notifications (12 unread)");
    });
  });

  test.describe("with an entity to open", () => {
    const entityName = unique("NoteEnt");
    test.use({ workspaceEntities: [entityName] });

    test("opening a notification goes to its entity, marks it read, and the read mark is kept after a reload", { tag: ["@regression"] }, async ({
      browser,
      baseURL,
      workspace,
    }) => {
      const entity = workspace.entities[0];
      await withSecondUser(browser, baseURL, async (user) => {
        const opened = unique("Open me ");
        const other = unique("Leave me ");
        await createNotifications(user.id, [
          {
            title: opened,
            type: "CHANGE_COMPLETE",
            minutesAgo: 1,
            entityRef: { entityId: entity.id, entitySlug: entity.slug, domainSlug: workspace.domainSlug, productSlug: workspace.productSlug },
          },
          { title: other, type: "DRIFT_ALERT", minutesAgo: 2 },
        ]);
        const page = await openAs(user);
        await expect(badge(page)).toHaveText("2");

        await bell(page).click();
        await page.getByTestId("notification-list").getByRole("button", { name: new RegExp(opened) }).click();
        await expect(page).toHaveURL(new RegExp(`/schemas/${workspace.domainSlug}/${workspace.productSlug}/${entity.slug}`));
        await expect(badge(page)).toHaveText("1");

        // The mark is in the database, not just on the page.
        await expect.poll(async () => (await notificationReadFlags(user.id))[opened]).toBe(true);
        expect((await notificationReadFlags(user.id))[other]).toBe(false);

        await openDashboard(page);
        await expect(badge(page)).toHaveText("1");
        await bell(page).click();
        await expect(page.getByTestId("unread-indicator")).toHaveCount(1);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Notification history
// ---------------------------------------------------------------------------

async function openHistory(page: Page): Promise<void> {
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Notification History", level: 1 })).toBeVisible();
  await expect(page.getByText("Loading...")).toHaveCount(0);
}

const rows = (page: Page): Locator => page.getByTestId("notification-row");

test.describe("notification history", () => {
  test("every notification is listed with its type, title, body and status; the type and status filters narrow the list", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    await withSecondUser(browser, baseURL, async (user) => {
      const t = { drift1: unique("Drift one "), drift2: unique("Drift two "), gap: unique("Gap "), change: unique("Change ") };
      await createNotifications(user.id, [
        { title: t.drift1, type: "DRIFT_ALERT", body: "Schema drifted in BigQuery", minutesAgo: 1 },
        { title: t.drift2, type: "DRIFT_ALERT", read: true, minutesAgo: 2 },
        { title: t.gap, type: "COMPLIANCE_GAP", minutesAgo: 3 },
        { title: t.change, type: "CHANGE_COMPLETE", read: true, minutesAgo: 4 },
      ]);
      const page = user.page;
      await openHistory(page);

      await expect(rows(page)).toHaveCount(4);
      // Newest first.
      await expect.poll(() => rows(page).evaluateAll((r) => r.map((row) => row.getAttribute("data-title")))).toEqual([t.drift1, t.drift2, t.gap, t.change]);
      const first = rows(page).first();
      await expect(first).toContainText("Drift Alert");
      await expect(first).toContainText("Schema drifted in BigQuery");
      await expect(first.getByText("Unread", { exact: true })).toBeVisible();
      await expect(rows(page).nth(1).getByText("Read", { exact: true })).toBeVisible();

      await page.getByTestId("notification-filter-type").selectOption("DRIFT_ALERT");
      await expect(rows(page)).toHaveCount(2);
      await page.getByTestId("notification-filter-read").selectOption("false");
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page)).toHaveAttribute("data-title", t.drift1);

      await page.getByTestId("notification-filter-type").selectOption("");
      await expect(rows(page)).toHaveCount(2);
      await expect.poll(() => rows(page).evaluateAll((r) => r.map((row) => row.getAttribute("data-read")))).toEqual(["false", "false"]);
      await page.getByTestId("notification-filter-read").selectOption("true");
      await expect(rows(page)).toHaveCount(2);
      await expect.poll(() => rows(page).evaluateAll((r) => r.map((row) => row.getAttribute("data-title")))).toEqual([t.drift2, t.change]);

      await page.getByTestId("notification-filter-type").selectOption("COMPLIANCE_GAP");
      await expect(page.getByText("No notifications found.")).toBeVisible();
      await expect(rows(page)).toHaveCount(0);
    });
  });

  test("a page holds 25: the 26th is on page 2, Previous and Next walk between them, and a filter returns to page 1", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    await withSecondUser(browser, baseURL, async (user) => {
      await createNotifications(
        user.id,
        Array.from({ length: 26 }, (_, i) => ({ title: `Boundary ${String(i + 1).padStart(2, "0")} ${unique("")}`, type: i === 25 ? ("DRIFT_ALERT" as const) : ("CHANGE_COMPLETE" as const), minutesAgo: i })),
      );
      const page = user.page;
      await openHistory(page);

      await expect(page.getByTestId("notifications-page")).toHaveText("Page 1");
      await expect(rows(page)).toHaveCount(25);
      await expect(page.getByTestId("notifications-previous")).toBeDisabled();
      await expect(page.getByTestId("notifications-next")).toBeEnabled();
      await expect(rows(page).first()).toHaveAttribute("data-title", /^Boundary 01 /);

      await page.getByTestId("notifications-next").click();
      await expect(page.getByTestId("notifications-page")).toHaveText("Page 2");
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page)).toHaveAttribute("data-title", /^Boundary 26 /);
      await expect(page.getByTestId("notifications-next")).toBeDisabled();
      await expect(page.getByTestId("notifications-previous")).toBeEnabled();

      await page.getByTestId("notifications-previous").click();
      await expect(page.getByTestId("notifications-page")).toHaveText("Page 1");
      await expect(rows(page)).toHaveCount(25);

      // Page 2 again, then a filter: the list starts over from page 1 (the one drift alert is the 26th, so it is on page 1 of its own list).
      await page.getByTestId("notifications-next").click();
      await expect(page.getByTestId("notifications-page")).toHaveText("Page 2");
      await page.getByTestId("notification-filter-type").selectOption("DRIFT_ALERT");
      await expect(page.getByTestId("notifications-page")).toHaveText("Page 1");
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page)).toHaveAttribute("data-title", /^Boundary 26 /);
    });
  });

  // KD-019: Next is enabled whenever the page is full (`notifications.length < pageSize`), so with exactly 25 it leads to an empty page 2.
  test.fail("[KD-019 Next is enabled on a last page that is exactly full] with exactly 25 notifications Next is disabled", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    await withSecondUser(browser, baseURL, async (user) => {
      await createNotifications(
        user.id,
        Array.from({ length: 25 }, (_, i) => ({ title: `Exact ${String(i + 1).padStart(2, "0")} ${unique("")}`, minutesAgo: i })),
      );
      const page = user.page;
      await openHistory(page);
      await expect(rows(page)).toHaveCount(25);
      await expect(page.getByTestId("notifications-next")).toBeDisabled({ timeout: 3000 });
    });
  });
});
