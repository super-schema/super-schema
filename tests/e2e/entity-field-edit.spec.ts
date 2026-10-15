/**
 * Entity field edit E2E (final review F7): the field write paths that went behind a tenant guard.
 * `updateFieldAction` now loads the field's entity and refuses (as "not found") anything outside the active tenant, and
 * `addFieldAction` checks the parent entity first. The admin here has NO tenant cookie, so the guard must fall back to the
 * default active organization (`getActiveTenantId`) and let every write through: a regression shows up as an error toast
 * ("Field not found" / "Entity not found") and a change that does not stick.
 *
 * Everything goes through the real UI on a fixture entity (see helpers/db.ts):
 *   1. Field Edit panel (right panel): describe a field, Save -> "Saved" flash, the row shows the description after a reload.
 *   2. Inline rename (field list): click the name, type, Enter -> the row shows the new name after a reload.
 *   3. "Add Field" > Quick Create (`addFieldAction`): the new row appears and survives a reload.
 *
 * Nothing is published (publishing leaves undeletable audit rows). The fixture domain, product and entity are removed in
 * `afterAll`.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, running dev server).
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect, unique } from "./helpers/auth";
import { createNavFixtures, deleteNavFixtures, disconnectDb, type NavFixtures } from "./helpers/db";

test.use({ navigationTimeout: 60_000, actionTimeout: 30_000, screenshot: "only-on-failure", trace: "retain-on-failure" });

/** A failed server action surfaces as an error toast (sonner). */
const errorToast = (page: Page) => page.locator('[data-sonner-toast][data-type="error"]');

/** The row of a field in the editor list (the name cell carries `title=<name>`). */
const fieldName = (page: Page, name: string): Locator => page.locator(`span[title="${name}"]`);

test.describe("entity field edit through the tenant-guarded actions", () => {
  // Serial: the rename relies on the field the previous test described, and the add on the renamed field list.
  test.describe.configure({ mode: "serial" });

  let fx: NavFixtures | undefined;

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

  const entityPath = () => {
    if (!fx) throw new Error("fixtures were not created");
    return `/schemas/${fx.domain.slug}/${fx.product.slug}/${fx.productEntity.slug}`;
  };

  async function openEntity(page: Page) {
    if (!fx) throw new Error("fixtures were not created");
    await page.goto(entityPath());
    await expect(page.getByRole("heading", { name: new RegExp(fx.productEntity.name, "i") }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: /^Fields \(\d+\)$/ })).toBeVisible({ timeout: 30_000 });
  }

  // The fixture entity's own field: `createNavFixtures` inserts a key field named "id".
  const FIXTURE_FIELD = "id";
  const renamed = unique("qa").replace(/-/g, "_");
  const added = unique("qa_add").replace(/-/g, "_");
  const description = `Described by the e2e field edit ${unique("d")}`;

  test("Field Edit panel: describe a field, Save shows the success state, and the description survives a reload", async ({
    authedPage: page,
  }) => {
    test.setTimeout(180_000);
    await openEntity(page);
    await expect(page.getByRole("heading", { name: "Fields (1)" })).toBeVisible();

    // Select the field by its row number (a non-interactive area of the row opens the Field Edit panel).
    await page.getByLabel("Row 1", { exact: true }).click();
    const panel = page.getByTestId("field-edit-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    await panel.getByRole("button", { name: "Add description..." }).click();
    await panel.getByPlaceholder("Add description...").fill(description);
    await page.keyboard.press("Enter");
    await expect(panel.getByText("Unsaved changes")).toBeVisible();

    await panel.getByTestId("field-save-btn").click();

    // Success state: the header flash, the Save bar gone, no error toast.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(panel.getByTestId("field-save-btn")).toHaveCount(0);
    await expect(errorToast(page)).toHaveCount(0);

    // Persisted: a fresh load of the page shows the description on the field row.
    await openEntity(page);
    await expect(page.getByTitle(description, { exact: true })).toBeVisible();
    await expect(errorToast(page)).toHaveCount(0);
  });

  test("inline rename: the new name is stored (trimmed) and survives a reload", async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    await openEntity(page);

    await fieldName(page, FIXTURE_FIELD).click();
    const input = page.locator("input:focus");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(FIXTURE_FIELD);
    // Padded on purpose: the action stores the trimmed name.
    await input.fill(`  ${renamed}  `);
    await input.press("Enter");

    await expect(fieldName(page, renamed)).toBeVisible();
    await expect(fieldName(page, FIXTURE_FIELD)).toHaveCount(0);
    await expect(errorToast(page)).toHaveCount(0);

    await openEntity(page);
    await expect(fieldName(page, renamed)).toBeVisible();
    await expect(fieldName(page, FIXTURE_FIELD)).toHaveCount(0);
    // The description set by the previous test is still on the (renamed) row.
    await expect(page.getByTitle(description, { exact: true })).toBeVisible();
  });

  test("Add Field > Quick Create: the new field is added and survives a reload", async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    await openEntity(page);
    await expect(page.getByRole("heading", { name: "Fields (1)" })).toBeVisible();

    await page.getByRole("button", { name: "Add Field", exact: true }).click();
    await page.getByPlaceholder("field_name").fill(added);
    await page.getByRole("button", { name: "Quick Create" }).click();

    await expect(fieldName(page, added)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fields (2)" })).toBeVisible();
    await expect(errorToast(page)).toHaveCount(0);

    await openEntity(page);
    await expect(fieldName(page, added)).toBeVisible();
    await expect(fieldName(page, renamed)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fields (2)" })).toBeVisible();
    await expect(errorToast(page)).toHaveCount(0);
  });
});
