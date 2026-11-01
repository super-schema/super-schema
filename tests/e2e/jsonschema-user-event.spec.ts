/**
 * JSON Schema import fidelity E2E (plan Task 14): the user's `user event` schema through the real UI.
 *
 *   paste -> Load -> Review (every field's classification, constraints, preserved extension block, dangling references) ->
 *   name prompt (ImportedEntity blocks Create) -> Create -> open the entity -> Schemas tab -> BigQuery asks for a primary key
 *   (`tenant` is suggested) -> save and generate.
 *
 * Pasted as text there is no base URL, so both `$ref`s (date_time.json, user_links.json) are dangling by design.
 * The function-level chain (importer -> persist -> emit with the real emitters) is tests/integration/jsonschema-user-event-e2e.test.ts.
 *
 * PREREQS: see helpers/auth.ts. Cleanup of the created domain needs DATABASE_URL (PostgreSQL provider, see helpers/db.ts); on PGlite it
 * is skipped with a warning and the domain stays.
 */

import { test, expect, unique } from "./helpers/fixtures";
import { expectPasteStatus, fillWorkbenchPaste } from "./helpers/workbench";
import { deleteDomainsByName, disconnectDb } from "./helpers/db";
import { createDomain, createProduct } from "./helpers/lifecycle";

const USER_EVENT = JSON.stringify({
  type: "object",
  description: "A user event containing user level customer id information used to link a user across different tenants.",
  properties: {
    component: {
      type: "string",
      description: "Name of the source component logging the user event(s).",
      minLength: 1,
      maxLength: 100,
      pattern: "^([A-Za-z0-9-_])+$",
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    },
    tenant: {
      type: "string",
      description: "Name of the adjacency to Acme.",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z0-9_]+$",
      "x-securityClassification": { data_class: "class4", data_category: "OrgCompany" },
    },
    created_time: {
      description: "Event creation timestamp.",
      $ref: "common_components/v4/schema/json/openapi-2.0/date_time.json",
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    },
    user_links: {
      type: "array",
      description: "List of list of users and their customer ids along with tenant information.",
      minItems: 1,
      maxItems: 100,
      items: { $ref: "user_links.json" },
    },
  },
  required: ["user_links", "created_time", "tenant"],
});

test.describe("JSON Schema import: user event, end to end", () => {
  const createdDomains: string[] = [];

  test.afterAll(async () => {
    try {
      await deleteDomainsByName(createdDomains);
    } catch (error) {
      console.warn(`jsonschema-user-event cleanup failed for ${createdDomains.join(", ")}: ${String(error)}`);
    } finally {
      await disconnectDb().catch(() => undefined);
    }
  });

  test("paste -> review shows every detail -> name prompt -> create -> BigQuery asks for the key", { tag: ["@smoke", "@regression"] }, async ({ authedPage: page }) => {
    const domain = unique("e2e-ue-domain-");
    createdDomains.push(domain);
    const product = unique("e2e-ue-product-");
    await createDomain(page, domain);
    const productUrl = await createProduct(page, domain, product);

    // 1. Workbench: paste, the live check says it loads, review.
    await page.goto(`${productUrl.replace(/\/+$/, "")}/new`);
    await expect(page.getByRole("heading", { name: /create new entity/i })).toBeVisible();
    await page.getByRole("button", { name: /import or build schema/i }).first().click();
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await fillWorkbenchPaste(page, USER_EVENT);
    await expectPasteStatus(page, "valid");
    await page.getByTestId("workbench-review-button").click();

    // 2. Single-entity review: the name prompt blocks Create while the placeholder name stands.
    const details = page.getByTestId("import-entity-details");
    await expect(details).toBeVisible();
    await expect(page.getByTestId("needs-name-hint")).toBeVisible();
    const create = page.getByRole("button", { name: /create entity/i });
    await expect(create).toBeDisabled();

    // 3. Every field's import details: expand them all.
    for (const field of ["component", "tenant", "created_time", "user_links"]) {
      await page.getByRole("button", { name: `Show import details of ${field}` }).click();
    }
    const table = page.locator("tbody");
    await expect(table).toContainText("Constraint: min length");
    await expect(table).toContainText("^([A-Za-z0-9-_])+$");
    await expect(table).toContainText("^[a-z0-9_]+$");
    await expect(table).toContainText("Constraint: min items");
    await expect(table).toContainText("Constraint: max items");
    await expect(table).toContainText("OrgCompany");
    await expect(table).toContainText("Preserved (kept, not interpreted)");
    await expect(table.getByText("x-securityClassification").first()).toBeVisible();
    // Both $refs are dangling (no base URL for a pasted text), each with its reason.
    await expect(page.getByTestId("parsed-field-dangling")).toHaveCount(2);
    await expect(table).toContainText("common_components/v4/schema/json/openapi-2.0/date_time.json");

    // 4. Rename, create.
    await page.getByPlaceholder("EntityName").fill("UserEvent");
    await expect(create).toBeEnabled();
    await create.click();
    // The import opens the NEW entity page (domain/product/entity), not the product page.
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+\/[^/]+$/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /UserEvent/ })).toBeVisible();
    // The unresolved references are flagged on the entity: Alerts lists them, and the entity stays DRAFT.
    await page.locator("main").getByText(/^Alerts \(\d+\)$/).first().click();
    await expect(page.getByText(/2 unresolved references: .*date_time\.json.*user_links\.json/)).toBeVisible();
    await page.locator("main").getByText("Editor", { exact: true }).first().click();
    // The imported level is shown as itself (class4), not as another level's label.
    await expect(page.locator("main span", { hasText: /^class4$/ }).first()).toBeVisible();
    await expect(page.locator("main span", { hasText: /^Sensitive$/ })).toHaveCount(0);

    // 5. Schemas tab: BigQuery asks for a primary key, `tenant` is pre-selected, saving generates the DDL.
    await page.locator("main").getByText("Schemas", { exact: true }).first().click();
    await page.getByRole("button", { name: /^Generate$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("needs a primary key");
    await expect(dialog.locator("label", { hasText: /^tenant$/ }).locator("input")).toBeChecked();
    // An array field cannot identify a row: it is not offered.
    await expect(dialog.locator("label", { hasText: /^user_links$/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: /save key and generate/i }).click();
    await expect(page.getByText("PRIMARY KEY (tenant) NOT ENFORCED")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/created_time: declared reference; stored as STRING/)).toBeVisible();
  });

  test("JSON Schema target generates for an entity with dangling references and keeps the raw $ref strings", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const domain = unique("e2e-ue-domain-");
    createdDomains.push(domain);
    const productUrl = await (async () => {
      await createDomain(page, domain);
      return createProduct(page, domain, unique("e2e-ue-product-"));
    })();
    await page.goto(`${productUrl.replace(/\/+$/, "")}/new`);
    await page.getByRole("button", { name: /import or build schema/i }).first().click();
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await fillWorkbenchPaste(page, USER_EVENT);
    await expectPasteStatus(page, "valid");
    await page.getByTestId("workbench-review-button").click();
    await page.getByPlaceholder("EntityName").fill("UserEvent");
    await page.getByRole("button", { name: /create entity/i }).click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+\/[^/]+$/, { timeout: 20_000 });

    await page.locator("main").getByText("Schemas", { exact: true }).first().click();
    await page.locator("main").getByText("JSON Schema (TypeSpec)", { exact: true }).first().click();
    await page.getByRole("button", { name: /^Generate$/ }).click();
    await expect(page.getByText("JSON Schema (TypeSpec) schema generated")).toBeVisible({ timeout: 30_000 });
    const preview = page.locator("main");
    await expect(preview).toContainText("common_components/v4/schema/json/openapi-2.0/date_time.json");
    await expect(preview).toContainText("user_links.json");
    await expect(preview).toContainText("x-securityClassification");
    await expect(preview).toContainText("OrgCompany");
    // no raw compiler diagnostic
    await expect(page.getByText(/invalid-ref|Unknown identifier/)).toHaveCount(0);
  });
});
